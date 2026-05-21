/* eslint-disable no-unused-vars */
/**
 * @module  companion-module-newblue-captivate
 * @author  NewBlue https://www.newbluefx.com
 * @details Connects Companion to Captivate (Titler Live)
 * @version 1.x
 * @license MIT
 */

/**
 * For information on what the companion base module can do, see:
 *
 * https://github.com/bitfocus/companion-module-base/blob/main/CHANGELOG.md
 *
 * and
 *
 * https://github.com/bitfocus/companion-module-base/blob/main/README.md
 */

/**
 * JSDoc types
 *
 * @import {CompanionActionDefinition, CompanionFeedbackDefinition, CompanionFeedbackInfo} from '@companion-module/base'
 *
 * @typedef {import('@companion-module/base').CompanionActionDefinition} CompanionActionDefinition
 * @typedef {import('@companion-module/base').CompanionFeedbackDefinition} CompanionFeedbackDefinition
 * @typedef {import('@companion-module/base').CompanionFeedbackInfo} CompanionFeedbackInfo
 *
 */

/** Imports */
const { InstanceBase, runEntrypoint, InstanceStatus, splitRgb } = require('@companion-module/base')

// Companion Elements
const Configuration = require('./lib/config')
const Actions = require('./lib/actions')
const Feedbacks = require('./lib/feedbacks')
const Presets = require('./lib/presets')
const UpgradeScripts = require('./lib/upgrades')

// other library imports
const { LocalCache } = require('./lib/cache')

// We need to use a specific version (5.9) of QWebChannel because 5.15 which ships with CP 2.2.1
// breaks compatibility with Captivate
const QWebChannelEx = require('./contrib/qwebchannel').QWebChannel
const WebSocket = require('ws')
const { Jimp } = require('jimp')
console.log(Jimp)

const blankFull = new Jimp({ width: 72, height: 72, color: 0x00000000 })
const blankFullBuffer = blankFull.getBuffer('image/png')

const CACHE_LIFETIME = 250 // ms
const USE_QWEBCHANNEL = true
const DEFAULT_BORDER_WIDTH = 2

let debug = () => {}
let error = () => {}

function promiseify(func) {
	return (...args) => {
		return new Promise((resolve, reject) => {
			// for scheduler calls, the last argument is a callback.
			args.push((e) => {
				resolve(e)
			})
			try {
				func(...args)
			} catch (e) {
				reject(e)
			}
		})
	}
}

class CaptivateInstance extends InstanceBase {
	/** @var {Object} sp Version of the scheduler where all the functions have been wrapped with promises */
	sp = {}
	customActions = {} // actions generated here, not defined in captivate

	extraLogging = false

	unsubscribers = []

	get instanceName() {
		return this.label
	}

	constructor(internal) {
		super(internal)

		// I guess this is one way to do composition... I don't like it though.
		Object.assign(this, {
			...Configuration,
			...Actions,
			...Feedbacks,
			...Presets,
		})

		this.selfId = (Math.random() * 1_000_000).toString(36)

		this.USE_QWEBCHANNEL = USE_QWEBCHANNEL
		this.timeOfLastDefinitionUpdates = new Date()
		this.colorIdx = 0

		/**
		 * The local feedback cache retains the last feedback state for feedbacks
		 * according to the id of the feedback.
		 *
		 * It also contains cached image data
		 */
		this.cache = new LocalCache()
		this.cache.setCacheLifetime(CACHE_LIFETIME)

		/** @type {Map<string, Promise>} debounce Captivate requests with promises */
		this.promises = new Map()

		this.titlesPlayStatus = []
		this.titlesImage = []
		this.titlesByName = {}
		this.titles = []
		this.variableNames = []

		// mapping from varid to {title, varname, value}
		this.varData = {}
	}

	// Called by Companion on connection initialization
	async init(config) {
		this.CHOICES_TITLES = [{ id: 0, label: 'no titles loaded yet', play: 'Done' }]
		this.on_air_status = []
		this.debug = debug = (...args) =>
			args.forEach((s) =>
				this.log('debug', 'CAPTIVATE:\n' + typeof s == 'string' ? s : JSON.stringify(s, undefined, 2)),
			)
		this.error = error = (...args) =>
			args.forEach((s) =>
				this.log('error', 'CAPTIVATE:\n' + typeof s == 'string' ? s : JSON.stringify(s, undefined, 2)),
			)

		this.configUpdated(config)
	}

	extraLog(...args) {
		if (this.extraLogging) {
			this.debug(...args)
		}
	}

	startExtraLogging(delay = 250) {
		this.debug('Starting extra logging for ' + delay + 'ms')
		this.extraLogging = true
		setTimeout(() => {
			this.extraLogging = false
		}, delay)
	}

	// Called when module gets deleted
	async destroy() {
		this.debug('destroy called')
	}

	async configUpdated(config) {
		this.config = config
		this.config.needsNewConfig = false
		this.debug('Configuration Changed')
		this.debug(config)
		if (this.USE_QWEBCHANNEL) {
			this.initQWebChannel()
		} else {
			this.refreshIntegrations()
		}
	}

	async refreshIntegrations() {
		// this.allowsFeedbackCacheRebuilding = true // will be changed from feedbacks.js

		await this.getCurrentTitles()
		this.setupFeedbacks() // from feedbacks.js
		this.setupActions() // from actions.js
		this.initPresets() // from presets.js

		// schedule another refresh in 5 minutes
		this.scheduleFunction('refresh', () => this.refreshIntegrations(), 300_000)
	}

	/**
	 * Initialize the QWebChannel connection to Captivate and register for events
	 */
	initQWebChannel() {
		this.config.needsNewConfig ??= false
		if (this.config.needsNewConfig) {
			this.log('debug', 'connection needs new configuration')
		}

		this.log('debug', JSON.stringify(this.config))
		let serverUrl = null
		if (this.config.bonjour_host) {
			serverUrl = `ws://${this.config.bonjour_host}` // will contain port
		} else {
			let port = this.config.port || 9023 // config defaults to 9023
			let host = this.config.host || '127.0.0.1' // config defaults to '127.0.0.1'
			this.config.port = port
			this.config.host = host
			serverUrl = `ws://${host}:${port}`
		}
		this.log('debug', `connecting to ${serverUrl}`)
		if (!serverUrl) return

		this.updateStatus(InstanceStatus.Connecting)
		let socket = new WebSocket(serverUrl)

		socket.on('open', () => {
			this.log('debug', 'A Connection to Captivate has been established')

			if (this.connectionWatchdog != undefined) {
				clearTimeout(this.connectionWatchdog)
				this.connectionWatchdog = undefined
			}

			// Establish API connection.
			new QWebChannelEx(socket, async (channel) => {
				// global and class scheduler objects
				this.scheduler = channel.objects.scheduler

				// wrap scheduler functions in promises... do this first!
				this.wrapScheduler()

				// call the other setup functions
				this.connectCallbacks()
				this.getImageSet()
				this.refreshIntegrations()

				// let Captivate know who we are and that we've connected, to customize behaviour and/or trigger startup logic
				let reply = await this.sp.notifyClientConnected('com.newblue.companion-module-captivate', '3.0', {})

				//host version reply will look like this:
				/*
          {
              "buildDate": "Feb 13 2024",
              "buildTime": "15:25:17",
              "host": "TitlerLive",
              "platform": "macos",
              "sku": "SKUTL5BR",
              "version": "5.9.240213"
          }
        */
				this.hostVersionInfo = JSON.parse(reply)
				debug(`Captivate: Host data:`)
				debug(this.hostVersionInfo)

				// tell companion we connected successfully
				this.updateStatus(InstanceStatus.Ok)
			})
		})

		socket.on('error', (data) => {
			this.updateStatus(InstanceStatus.BadConfig)
			this.log('warning', `NewBlue: Captivate: Connection error ${data}.`)
			this.status && this.status(this.STATUS_WARNING, 'Disconnected')
			this.config.needsNewConfig = true
			// this.config.port = ''
			// this.config.host = ''
		})

		socket.on('close', () => {
			this.updateStatus(InstanceStatus.Disconnected)
			this.log('warning', 'NewBlue: Captivate: Connection closed.')
			this.status && this.status(this.STATUS_WARNING, 'Disconnected')

			if (this.connectionWatchdog == undefined) {
				// let's periodically try to make a connection again
				this.connectionWatchdog = setInterval(() => {
					this.initQWebChannel()
				}, 5000)
			}
		})
	} // end: initQWebChannel

	/** wrap the scheduler functions in promises so we can use them with async/await paradigms */
	wrapScheduler() {
		this.scheduler.promised = {}
		for (let [k, v] of Object.entries(this.scheduler)) {
			if (typeof v == 'function') {
				this.scheduler.promised[k] = promiseify(v)
			} else if (typeof v == 'object' && v.connect) {
				v._connect = v.connect
				v.connect = (fn) => {
					v._connect(fn)
					return () => v.disconnect(fn)
				}
				this.scheduler.promised[k] = v
			} else {
				this.scheduler.promised[k] = v
			}
		}
		// make sure the scheduler is updated if it needs to be
		if (globalThis.scheduler !== this.scheduler) globalThis.scheduler = this.scheduler
		this.sp = this.scheduler.promised
	}

	/** Requests the automation images from the Captivate backend. */
	async getImageSet() {
		// companion will assume it's png data
		const includeMimePrefix = false
		const reply = await this.sp.getImageSet('automation.glow.base', includeMimePrefix)
		for (let [name, data] of Object.entries(reply)) {
			this.debug(`caching image data for: ${name}`, data)
			this.cache.setImageData(name, data)
		}
	}

	/**
	 * Creates a Companion-style variable definition from a Captivate title and variable name.
	 *
	 * @param {string} title A Captivate title object
	 * @param {string} varname A Captivate variable name
	 * @returns
	 */
	makeVarDefinition(title, varname) {
		const name = `${title.name}: ${varname}` // the label
		const variableId = `${title.name}__${varname}`.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_')
		return { name, variableId }
	}

	// only visible to companion, so it doesn't have to follow the entire newblue action schema
	makeCustomActionId(actionName) {
		return `newblue.automation.js.${actionName}`
	}

	// only visible to companion, so it doesn't have to follow the entire newblue action schema
	makeCustomFeedbackId(type, feedbackName) {
		return `newblue.automation.js.feedback.${type}.${feedbackName}`
	}

	/**
	 *
	 * @param {string} shortId
	 * @param {(action:CompanionActionDefinition)=>void} callback
	 */
	registerCustomAction(shortId, callback) {
		let actionId = this.makeCustomActionId(shortId)
		this.customActions[actionId] = callback
	}

	/**
	 * Gets all the information for the current project titles and uses that information to
	 * - cache the icons for each title -- TODO
	 * - set up companion variables for each title variable
	 * - set up companion variables for each data controller variable
	 */
	async getCurrentTitles() {
		const varDefinitions = []
		this.varData = {}
		this.varValues = {}
		const reply = await this.sp.scheduleCommand('getTitleControlInfo', { icon: 1, height: 72, width: 72 }, {})
		try {
			const data = JSON.parse(reply)
			let varnames = new Set()
			this.titlesByName = {}
			this.titlesById = {}
			this.titles.reverse() // they always come in backward
			this.titles = data.titles ?? []
			this.titles.reverse()
			for (let title of this.titles) {
				this.titlesByName[title.name] = title
				this.titlesById[title.id] = title

				for (let variable of title.variables) {
					let def = this.makeVarDefinition(title, variable.variable)
					varDefinitions.push(def)
					this.varData[def.variableId] = { title, varname: variable.variable, value: variable.value }
					this.varValues[def.variableId] = variable.value
					varnames.add(variable.variable)
				}
			}
			this.variableNames = [...varnames.values()]
			this.variableNames.sort()

			// setting variables doesn't seem to work
			// this.debug(varDefinitions);
			// this.debug(varValues);
			this.setVariableDefinitions(varDefinitions)
			this.setVariableValues(this.varValues)
			// this.setVariableDefinitions([{name: 'cool variable', variableId: 'cool_variable'}]);
			// this.setVariableValues({'cool_variable': 'hello'})
		} catch (e) {
			this.error(e)
			throw e
		}
	}

	disconnectCallbacks() {
		for (const unsub of this.unsubscribers) {
			unsub?.()
		}
	}

	/**
	 * Some Captivate events get pushed to us through _cmp_v1 signals.
	 */
	connectCallbacks() {
		// used to force a reload of this controller
		this.disconnectCallbacks()
		let unsub = this.sp.messageIn.connect((from, to, data) => {
			if (from != this.selfId && to == 'companion-module') {
				data = JSON.parse(data)
				this.debug('Message from', from, 'to', to, 'data', data)
				if (data.reload) {
					this.debug('Reloading Companion')
					this.refreshIntegrations()
				}
			}
		})
		this.unsubscribers.push(unsub)

		// This event is triggered when something changes the internal automation registry in Captivate
		// However, the Captivate database might get updated multiple times by multiple different calls
		// so we only want to request new data after the Captivate database has settled down.
		// To do that, we debounce this function for 1000ms.
		unsub = this.sp._cmp_v1_handleActorRegistryChangeEvent.connect((category, actorId) => {
			// category will be one of the following: 'actorDelete', 'resetRegistry', 'actions', 'presets', 'feedbacks'
			this.debug(`****Captivate Automation Registry updated`, category, actorId)

			// this method runs the first one and then ignores all subsequent calls for 1000ms
			this.scheduleFunction('registry_refresh', () => this.refreshIntegrations(), 1000)
		})
		this.unsubscribers.push(unsub)

		// This signal is triggered when something triggers a feedback event in Captivate
		// If the triggering event sends an empty state object, treat it as a signal to
		// re-poll the new data. To do that, we just need to empty the old data from the cache.
		const feedbackDebounce = new Map()
		unsub = this.sp._cmp_v1_handleFeedbackChangeEvent.connect(async (actorId, feedbackId, options, state) => {
			// if (options.inputKey) {
			// 	this.startExtraLogging(250)
			// }
			if (feedbackId.match(/csv\.feedback\.native/) || feedbackId.match(/weathercast/)) {
				this.startExtraLogging(250)
			}
			this.extraLog('Feedback change event received from Captivate:', { actorId, feedbackId, options, state })

			const fullId = `${actorId}~${feedbackId}`

			// if we are already processing this feedback, ignore it
			if (feedbackDebounce.has(fullId)) return
			feedbackDebounce.set(fullId, true)
			setTimeout(() => {
				feedbackDebounce.delete(fullId)
			}, 100)

			// before we do anything with the feedback state, we want to check if we need to do any processing on it based on the feedbackId
			// this is because sometimes invalid values get stored in the state object
			state = await this._handleFeedbackState(state)

			// did we get a new state object with data? if so, process it and cache it
			const has_state = state && Object.keys(state).length > 0
			if (has_state) {
				this.cache.storeFromFullId(fullId, options, state, CACHE_LIFETIME)
			} else {
				// we didn't get any state data, so we need to request it again
				// console.log('Feedback change event had no state, clearing cache:', fullId)
				// state = await this.getFeedbackState(fullId, options)
				// console.log(fullId, state)
				this.cache.removeFromFullId(fullId, options)
			}

			// this tells Companion to poll this feedback again
			// pragmatically, this will then lead to handleFeedbackRequest being called
			// which will grab the real state from the cache or from Captivate
			// this.debug('Scheduling feedback check for ' + fullId)
			this.checkFeedbacks(fullId)

			// because we debounced this function, we might have gotten out of sync with
			// Captivate. as a result, let's schedule an extra feedback check
			// since the check uses the cache when possible, each call should be fast
			// this.scheduleFunction(fullId, () => this.checkFeedbacks(fullId), 100);
			this.scheduleFunction('all-feedbacks', () => this.checkFeedbacks(), 500)
		})
		this.unsubscribers.push(unsub)

		// When Captivate issues a data event
		this.unsubscribers.push(this.sp.onNotify.connect(this.handleNotification.bind(this)))
		this.sp.scheduleCommand('subscribe', { events: 'play,data' }, {})
	}

	/**
	 * Schedule a function for future execution. If the function is already scheduled,
	 * the previous schedule will be cleared and replaced with the new one.
	 *
	 * @param {string} key
	 * @param {Function} fn
	 * @param {number} delay milliseconds to wait before running the function
	 */
	scheduleFunction(key, fn, delay = 1000) {
		this.scheduleRunner ??= new Map()
		if (this.scheduleRunner.has(key)) {
			clearTimeout(this.scheduleRunner.get(key))
		}
		const timer = setTimeout(() => {
			fn()
		}, delay)
		this.scheduleRunner.set(key, timer)
	}

	/**
	 * This handles a notification message from Captivate.
	 * Currently, it only cares about data events, but will
	 * update Companion variables based on the incoming data.
	 *
	 * @param {any} msg
	 */
	handleNotification(msg) {
		try {
			let { event, id, variables } = JSON.parse(msg)
			if (event == 'data' && id && variables && this.titlesById[id]) {
				let title = this.titlesById[id]
				for (let { name, value } of variables) {
					this.setVar({ title, name, value })
				}
			}
			// this.debug(data);
		} catch (e) {
			this.debug('handleNotification Error:', e)
		}
	}

	/**
	 * Define or update a Companion variable
	 *
	 * @param {any} param0
	 */
	setVar({ varid, title, name, value }) {
		if (title && name && !varid) {
			varid = this.makeVarDefinition(title, name).variableId
		}
		if (varid in this.varData) {
			this.varData[varid].value = value
			this.varValues[varid] = value
			title = this.varData[varid].title
		}
		this.setVariableValues({ [varid]: value })

		// this doesn't seem needed since we are tracking the variables internally
		// but it could be helpful and doesn't seem too wasteful
		for (let titlevar of title.variables) {
			if (titlevar.variable == name) {
				titlevar.value = value
				break
			}
		}
	}

	/**
	 * Request actions, presets, feedbacks, etc from Captivate. These will be parsed into real
	 * action, preset, feedback objects, and will be registered in the Companion system.
	 *
	 * @param {'actions'|'presets'|'feedbacks'|'lastUpdateTimestamp'} kind gets current data from Captivate for presets, etc.
	 * @returns
	 */
	async requestCompanionDefinition(kind) {
		// kind = 'actions' | 'presets' | 'feedbacks'
		const reply = await this.sp._cmp_v1_query(kind)
		this.log(reply)
		try {
			if (kind === 'actions') return reply.companion_actions
			if (kind === 'presets') return reply.companion_presets
			if (kind === 'feedbacks') return reply.companion_feedbacks
			if (kind === 'lastUpdateTime') return reply.companion_lastUpdateTime
			throw 'Type not supported'
		} catch (e) {
			this.error(e)
			throw e
		}
	}

	/**
	 * This function expects a state that looks like this:
	 * 
	 * {
			"overlayImageName": "play_layer",
			"overlayImageName_paused": "play_layer_red",
			"overlayImageName_running": "play_layer_red",
			"overlayQueryKey": "{91883451-a9f6-495f-9c3e-68a33ae051a3}",
			"png64": "iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAEhklEQVR4nO3XT0gcVxwH8O+b2aQaibth/4zu2nWjWFBBsWmlBN2qbcillDaXIB56CHrrKSDoIZSWirCHQumhubRQcrE9tEJPW6sxCNYmht6EXZsEcdf5s/8tu9XNzOvBnc1kskqThrTF3wdk5/3em/d+85s3sytACCGEEEIIIYQQQgghhBBCCCGEPD+KonBrOxKJXAfw47PONz8/v6yqKgfArHFVVfmlS5duP+18q6urf9hjqVSKi6LY8qw5MsZYKpUyDusXzINkMvlwcHDwSnd397xtjPisiwPA6Ojob06n82trbGRk5K517b+Lc87sMY/Hw3Rd3/4HKR6pmqQgCGIsFvtqcXHx3VoDVVXlmUyGp9NpXi6XOXCw40ZGRr6oHBsAvreft7S0JMdisQ/MdiKR2L9///4Vsy3L8sNCocALhQKv7LbqeuYfgJeAg7udy+V4KpXiuVyOA4/vIE3TeCqV4pqmcQABM6ZpGk+n01xRFN2cX9M0Lsuykc1mq7snGo3+qmkaz2az1VwclY7bfr//50qhACAM4Jb1Ql0uF06ePMnMpBhjpyVJYqqq8suXL9/SdR0A3q9VXM55NYm6uroTLS0t+5Y+sbGxkVmK7NrY2Ij7fL4ogIsAsLW1pQeDQbG9vb3e5XIxs4DWNWZmZj5vbW29WSwWhys3wgiFQifOnz9/Ox6P95tFMT+9Xu85AHcr12MAQF9f3+ter5cBQH19fWh2dvaBAAC9vb2v7ezsvKUoCjcMA8lk8qZ18QsXLryTzWahKApXFIXrug7O+UcAIEmSODc3N+f3+w99ZDo6Os709PT85HA4HG63+7F3WjQa/cHcKYwxBqDF7XZ7GGPXzDHBYFAEgM3NzaJt6uojNzEx8WGxWJw124FAQCiXy/rKyso5cxfZzr1rz5PzR0NKpdKD8fHxoMMMSJJUXcz+sl5eXo5ubGwUh4aGGgAgFAq1A/gdAGRZ1gcGBq5V7soT7wgA2N3dLSwsLLyt6/qfzc3NDgBdZt/Y2Nh7DofDuoPMZF8GsAYA+XyeO53OmnNb1tgF0Gpp80QioYVCoZVSqfQm8GgH1cIOVNuCIAiKopSFRCJRliTpW+vgGzdufHPnzp2S2d7f39/v7Ow8NT09/dnk5OTHa2trmwCQyWR4f3//L7FY7BPDMDiA0BEJwOl0PvHCz2QyAIB79+4VGGNMEATB5/MxVVW/CwQCgWw2y8Ph8PpRxQGAs2fPNmqadr2hoaEpn8/zq1evbg4PDw9sb2+HgYMim2O9Xi9TVdWQJKnZLBrnnO/t7ZXX19dVv9/foiiK3tXVdRGMMc8hF+SplLTaL4riK6IoDlnH2M+xtRkAtyV02HEYwGkcPDL2+Ku15meMeSufdXj8mzbMGHvDbAiCcKoyD6uMdVjH2ucVBOGMGSfkOYpEIl/WiieTyfKLzuW/RAAAWZaNtra2Dnun/bfGcSQAQFNTk8CtPwIqfD7fkV+tx8FT/z903NQsUDwez7/oRP5XpqamPv23cyCEEEIIIYQQQgghhBBCCCGEEEIIIQD+AjRuD8kAJAz9AAAAAElFTkSuQmCC",
			"text": " "
		 }
	 * 
	 * This function will take the overlayQueryKey and use it to determine the play state of the layer
	 * Then, it will automatically select the proper overlayImageName to use based on the play state.
	 * 
	 * It might also receive a pngQueryKey which will be used to specifically set the png value.
	 * 
	 * The result of this function should then be passed through the _handleFeedbackOverlayImage function
	 * 
	 * @param {any} state 
	 * @returns 
	 */
	async _handleFeedbackOverlayPlayStates(state) {
		// query for our layer play states, we will use this to fold into our feedback state
		const playStates = await this.sp.getValueForKey('newblue.automation.layerstate')

		// did the feedback data include a dynamic image?
		if (hasProperty(state, 'overlayQueryKey')) {
			let s = playStates[state.overlayQueryKey]
			if (s == undefined || !hasProperty(s, 'playState')) {
				// we have a property
				s = {}
				s.playState = 'unknown'
			}

			if (hasProperty(state, 'overlayImageName_running')) {
				if (s.playState === 'running') {
					state.overlayImageName = state.overlayImageName_running
				}
				delete state.overlayImageName_running
			}

			if (hasProperty(state, 'overlayImageName_paused')) {
				if (s.playState === 'paused') {
					state.overlayImageName = state.overlayImageName_paused
				}
				delete state.overlayImageName_paused
			}

			// done
			delete state.overlayQueryKey
		}

		if (hasProperty(state, 'pngQueryKey')) {
			let s = playStates[state.pngQueryKey]
			if (s == undefined || !hasProperty(s, 'playState')) {
				s = {}
				s.playState = 'unknown'
			}

			// we have a property
			if (hasProperty(state, 'png_running')) {
				if (s.playState === 'running') {
					state.png = state.png_running
				}
				delete state.png_running
			}

			if (hasProperty(state, 'png_paused')) {
				if (s.playState === 'paused') {
					state.png = state.png_paused
				}
				delete state.png_paused
			}

			// done
			delete state.pngQueryKey
		}
		return state
	}

	/**
	 *
	 * @param {*} image
	 * @param {string|number} borderColor
	 * @param {string|number} borderWidth if string, left, top, right, bottom delimited by spaces
	 */
	async _drawBorder(image, borderColor, borderWidth) {
		// jimp colors are in the format 0xRRGGBBAA, where AA is the alpha channel
		// companion uses the format 0xAARRGGBB, where AA is the alpha channel
		//
		// incoming borderColor can be a string (hex) or a number (integer)
		// if it's a string, we assume it's a hex color code (e.g. '#ff0000' or '#ff0000ff', rrggbbaa)
		// if it's a hex color code, we convert it to an integer with alpha channel (alpha is the lowest byte)
		// if it's a number, we assume it's an integer color value in companion format (e.g. 0xAARRGGBB)
		// if it's a number, we will need to convert it to Jimp format (0xRRGGBBAA)
		//
		// Let Companion do the parsing for us (alpha will be a value between 0 and 1)
		const { r, g, b, a } = splitRgb(borderColor)

		// assemble to a Jimp-compatible color value
		borderColor = (r << 16) | (g << 8) | b // convert to Jimp format (0xRRGGBB)
		borderColor = (BigInt(borderColor) << 8n) | BigInt(a * 255) // add the alpha
		borderColor = Number(borderColor) // convert back to number

		// if (typeof borderColor == 'string' && borderColor.startsWith('#')) {
		// 	const noLeadingHash = borderColor.slice(1) // remove the leading #
		// 	borderColor = parseInt(noLeadingHash, 16) // convert hex to integer
		// 	if (noLeadingHash.length <= 6) {
		// 		borderColor = (BigInt(borderColor) << 8n) | 0xffn // add alpha channel (fully opaque)
		// 		borderColor = Number(borderColor) // convert back to number
		// 	}
		// }

		const { width, height } = image.bitmap

		let left, top, right, bottom
		if (typeof borderWidth == 'string') {
			// if it's a string, split it by spaces and parse the values
			;[left, top, right, bottom] = borderWidth.split(' ').map((w) => parseInt(w, 10))

			if (left == undefined) left = DEFAULT_BORDER_WIDTH
			if (top == undefined) top = left
			if (right == undefined) right = left
			if (bottom == undefined) bottom = top
		} else {
			borderWidth = Math.max(borderWidth, 0) // disallow negative values
			;[left, top, right, bottom] = [borderWidth, borderWidth, borderWidth, borderWidth] // companion's eslint uses this construct for destructuring
		}

		// Top border
		image.scan(0, 0, width, top, (x, y, idx) => {
			image.bitmap.data.writeUInt32BE(borderColor, idx)
		})

		// Bottom border
		image.scan(0, height - bottom, width, bottom, (x, y, idx) => {
			image.bitmap.data.writeUInt32BE(borderColor, idx)
		})

		// Left border
		image.scan(0, 0, left, height, (x, y, idx) => {
			image.bitmap.data.writeUInt32BE(borderColor, idx)
		})

		// Right border
		image.scan(width - right, 0, right, height, (x, y, idx) => {
			image.bitmap.data.writeUInt32BE(borderColor, idx)
		})
	}

	async _handleFeedbackOverlayImage(state) {
		if (hasProperty(state, 'overlayImageName')) {
			let layerImageData = await this.cache.getImageData(`${state.overlayImageName}`)
			state.__old__overlayImageName = state.overlayImageName
			delete state.overlayImageName

			if (!layerImageData) {
				debug('bad layer data')
			} else if (hasProperty(state, 'png64')) {
				const baseImage = Buffer.from(state.png64, 'base64')
				const overlayImage = Buffer.from(layerImageData, 'base64')

				// Load the base image
				let base, overlay

				try {
					base = await Jimp.read(baseImage)
				} catch (e) {
					this.error('Error loading base image from state.png64:', { error: e, state })
					base = blankFull
				}

				try {
					overlay = await Jimp.read(overlayImage)
				} catch (e) {
					this.error('Error loading base image from state.layerImageData:', { error: e, state })
					overlay = blankFull
				}

				// Resize overlay to match base image, if necessary
				overlay.resize({ w: base.bitmap.width })

				// Composite the overlay onto the base image
				base.composite(overlay, 0, 0, {
					mode: Jimp.BLEND_SOURCE_OVER,
					opacitySource: 1.0,
					opacityDest: 1.0,
				})

				if (hasProperty(state, 'borderColor') || hasProperty(state, 'borderWidth')) {
					await this._drawBorder(base, state.borderColor, state.borderWidth ?? DEFAULT_BORDER_WIDTH)
					delete state.borderColor
					delete state.borderWidth
				}

				// Convert to buffer
				const result = await base.getBase64('image/png')
				if (result) {
					state.png64 = result
				}
			} else {
				// fall back
				state.png64 = this.layerImageData
			}
		} else if (hasProperty(state, 'imageName') && state.imageName) {
			state.png64 = await this.cache.getImageData(`${state.imageName}`)
			delete state.imageName
		}
		return state
	}

	/**
	 * This function should be called after all the other image functions because it assumes
	 * that stat.png64 is set to the image data.
	 *
	 * @param {*} state
	 * @returns {Promise<*>}
	 */
	async _handleFeedbackBorderColor(state) {
		const baseImage = state.png64 ? Buffer.from(state.png64, 'base64') : blankFullBuffer
		let image
		try {
			image = await Jimp.read(baseImage)
		} catch (e) {
			this.error('Error loading base image from state.png64:', { error: e, state })
			image = await Jimp.read(blankFullBuffer)
		}

		await this._drawBorder(image, state.borderColor, state.borderWidth ?? DEFAULT_BORDER_WIDTH)
		delete state.borderColor
		delete state.borderWidth

		// Convert to buffer
		const result = await image.getBase64('image/png')
		if (result) {
			state.png64 = result
		}
		return state
	}
	/**
	 * This function takes the feedback state that comes from Captivate, and does the following:
	 * 1. convert the Captivate feedback data into a format that Companion can use
	 * 2. if the feedback data includes an image, handle it.
	 *
	 * @param {*} state
	 * @returns
	 */
	async _handleFeedbackState(state) {
		if (!state) return state
		const original = { ...state }

		// first, handle the items that are sent to us by Captivate
		if (state.overlayQueryKey || state.pngQueryKey) {
			// debug('state with overlay query keys', state)
			state = await this._handleFeedbackOverlayPlayStates(state)
			// debug('state with overlay information', state)
		}

		// now, handle the specified overlay image if there is one
		if (state.overlayImageName || state.imageName) {
			// debug('state with overlay image name keys', state)
			state = await this._handleFeedbackOverlayImage(state)
			// debug('state with overlay information', state)
		}

		if (state.borderColor || state.borderWidth) {
			// debug('state with border color', state)
			state = await this._handleFeedbackBorderColor(state)
			// debug('state with border color applied', state)
		}

		state = await this._adaptToCompanionStyle(state)

		this.extraLog('Feedback state after preparing for Companion:', { original, converted: state })

		return state
	}

	/**
	 *
	 * The advanced feedbacks can also take an `imageBuffer` (Uint8Array), and an `imagePosition` value. See the `CompanionAdvancedFeedbackResult` type for more.
	 * @param {*} state The state that comes from Captivate. It could have any number of fields, but we only care about the ones that are relevant to Companion.
	 * @returns {Promise<import('@companion-module/base').CompanionFeedbackButtonStyleResult|import('@companion-module/base').CompanionAdvancedFeedbackResult>}
	 */
	async _adaptToCompanionStyle(state) {
		let result = {}
		for (let property of [
			'text',
			'size',
			'color',
			'bgcolor',
			'alignment',
			'png64',
			'pngalignment',
			'show_topbar',
			/* advanced only */
			'imageBuffer',
			'imageBufferEncoding',
			'imagePosition',
			/* boolean feedbacks only use `value` */
			'value',
		]) {
			if (hasProperty(state, property)) {
				result[property] = state[property]
			}
		}

		// our Automation Library uses different field names for some properties
		if (state.textColor) result.color = state.textColor
		if (state.backgroundColor) result.bgcolor = state.backgroundColor
		if (state.textSize) result.size = state.textSize
		if (state.textAlign) result.alignment = state.textAlign
		if (state.showTopBar) result.show_topbar = state.showTopBar
		if (state.imageAlign) result.pngalignment = state.imageAlign

		// we can pass raw base 64 image data to Companion using the image64 property (png64 will take precedence)
		if (!result.png64 && state.image64) {
			result.png64 = state.image64
		}

		// we can pass other image data to Companion using imageNames, imagePath, or imageUrl (png64 will take precedence)
		let imageKey = state.imageName || state.imageUrl || state.imagePath
		if (!result.png64 && imageKey) {
			// this.debug('requesting image data from cache', imageKey)
			const imageData = await this.cache.getImageData(imageKey)
			// this.debug('image data', imageData)
			if (imageData != undefined) {
				result.png64 = imageData
			}
		}

		return result
	}

	/**
	 * This asks Captivate what the current value of this feedback should be.
	 * If the current feedback value should be an image, Captivate can push it to us.
	 *
	 * This is the lower-level version of the call. In most cases, you want to use
	 * getFeedbackState instead.
	 *
	 * This function will also save the feedback state to our cache.
	 *
	 * @param {string} fullFeedbackId the actor id will be connected to the feedbackId by a '~'
	 * @param {object} options The options as they are set in the feedback object
	 * @returns {Promise<{[key: string]: string|number|boolean}>}
	 */
	async _queryFeedbackState(fullId, options) {
		const [actorId, scope, fbkid] = fullId.split('~', 3)

		// older versions of this module didn't understand scopes for feedbacks
		// so older versions of Captivate didn't send the scope.
		// Once everyone is on this version of the companion module, the Captivate
		// backend can be updated to send scopes with feedbacks.
		// for now, if the fbkid is empty, we will use the scope as the feedback id
		const feedbackId = fbkid || scope

		// console.log('Asking Captivate for feedback state:', actorId, feedbackId, options)
		let reply
		let state
		try {
			// fix feedback options for the 'input-routed.activesheet' feedback
			// not needed for builds of captivate after 2025-01-17
			if (feedbackId.match(/input-routed\.activesheet/) && !options.inputName) {
				options = { ...options, inputName: 'Spreadsheet: _active_' }
			}

			reply = await this.sp._cmp_v1_queryFeedbackState(actorId, feedbackId, options)
			this.extraLog('_cmp_v1_queryFeedbackState response', { actorId, feedbackId, options, reply })
			if (!reply) {
				return {}
			}
			state = JSON.parse(reply)

			// this.debug('_cmp_v1_queryFeedbackState response', { actorId, feedbackId, options, state })
			state = await this._handleFeedbackState(state) // will convert image names to images
			// this.debug('state after handling for Companion', { state })
			this.cache.store(actorId, feedbackId, options, state, CACHE_LIFETIME)
			return state
		} catch (e) {
			this.error(`Error parsing response for ${feedbackId}`)
			this.error({ error: e, reply })
			return {}
		}
	}

	/**
	 * This will return a cached feedback state if it exists, otherwise it will ask Captivate for the feedback state.
	 *
	 * @param {string} fullId the actor id and feedback id will be connected by a '~'
	 * @param {object} options The options as they are set in the feedback object
	 * @returns {Promise<[{[key: string]: string|number|boolean}, boolean]>} the second value will be true if it was a fresh query
	 * @throws {string}
	 */
	async getFeedbackState(fullId, options) {
		return this.cache.getPromisedFromFullId(fullId, options, async () => {
			const state = await this._queryFeedbackState(fullId, options)

			this.extraLog('Companion requested a feedback not in the cache:', {
				feedback: fullId,
				options,
				captivate_response: state,
			})

			return state
		})
	}

	/**
	 * @brief Query Captivate to determine if there have been updates to the actions/presets/feedbacks
	 * @returns an ISO timestamp that's recorded when definitions were last updated
	 * @details
	 *  This makes a lightweight call to the automation registry to look for any changes.
	 */
	async checkForDefinitionUpdates() {
		if (this.USE_QWEBCHANNEL) {
			let response = await this.requestCompanionDefinition('lastUpdateTime')
			// this.debug(response)
			var lastUpdate = new Date(response)
			if (lastUpdate >= this.timeOfLastDefinitionUpdates) {
				this.timeOfLastDefinitionUpdates = lastUpdate
				this.refreshIntegrations()
			}
		}
	}

	/**
	 * This will be used as the callback for a companion feedback.
	 *
	 * @param {import('@companion-module/base').CompanionFeedbackBooleanEvent|import('@companion-module/base').CompanionFeedbackAdvancedEvent} event
	 * @returns
	 */
	async handleFeedbackRequest(event) {
		// DO NOT JUST DEBUG HERE... THERE ARE TOO MANY CALLS EVERY SECOND... USE IF STATEMENTS!!
		this.extraLog('~~~~~~~~~~ Feedback Callback ~~~~~~~~~~~~')
		this.extraLog(event)
		this.extraLog('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~')

		// the feedbackId will be the full actor/feedback id (actorId~feedbackId)
		let [state, from_cache] = await this.getFeedbackState(event.feedbackId, event.options)
		this.extraLog('Returning feedback state:', {
			feedbackId: event.feedbackId,
			options: event.options,
			state,
			from_cache,
		})
		return event.type == 'boolean' ? !!state?.value : state
	}

	/**
	 * Combine rgb components to a 24bit value (copied from lib/Resources/Util.js)
	 * @param {number | string} r 0-255
	 * @param {number | string} g 0-255
	 * @param {number | string} b 0-255
	 * @param {number} base
	 * @returns {number | false}
	 */
	rgb(r, g, b, base = 10) {
		// @ts-ignore
		r = parseInt(r, base)
		// @ts-ignore
		g = parseInt(g, base)
		// @ts-ignore
		b = parseInt(b, base)

		if (isNaN(r) || isNaN(g) || isNaN(b)) return false
		return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
	}
} // end: CaptivateInstance

/**
 * Combine rgb components to a 24bit value (copied from lib/Resources/Util.js)
 * @param {number | string} r 0-255
 * @param {number | string} g 0-255
 * @param {number | string} b 0-255
 * @param {number} base
 * @returns {number | false}
 */
function rgb(r, g, b, base = 10) {
	// @ts-ignore
	r = parseInt(r, base)
	// @ts-ignore
	g = parseInt(g, base)
	// @ts-ignore
	b = parseInt(b, base)

	if (isNaN(r) || isNaN(g) || isNaN(b)) return false
	return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

class CompanionFeedbackState {}

class CompanionFeedback {
	/** @type {string} */
	id = '' // the unique id used by companion to identify this feedback

	/** @type {'boolean'|'advanced'} */
	type = 'boolean'

	/** @type {string} */
	name = 'Unnamed' // displayed to the user

	/** @type {{bgcolor: number|string, color: number|string}} */
	defaultStyle = {} // used whenever the feedback doesn't specify a style

	/** @type {Array<{type: string, label: string, id: string, default: any}>} */
	options = [] // options that can be set by the user to identify when this feedback should be used

	/** @type {(feedback: any, context: any|undefined) => (boolean|object)|null} */
	callback // will be called by companion to get the feedback state

	constructor({ type = 'boolean', name = 'Unnamed', defaultStyle = {}, options = {}, callback = null }) {
		this.type = type || 'boolean'
		this.name = name || 'My first feedback'
		this.defaultStyle = defaultStyle || {
			bgcolor: rgb(255, 0, 0),
			color: rgb(0, 0, 0),
		}
		this.options = options || [
			{
				type: 'number',
				label: 'Source',
				id: 'source',
				default: 1,
			},
		]
		this.callback = callback
	}

	static fromCaptivateState(state) {
		return new CompanionFeedback({
			type: state.type,
			name: state.name,
			defaultStyle: state.defaultStyle,
			options: state.options,
			callback: state.callback,
		})
	}
}

/**
 * Because of the security issues related to object.hasOwnProperty, we use this
 * to wrap it in the better alternative.
 *
 * see https://eslint.org/docs/latest/rules/no-prototype-builtins
 *
 * @param {any} s
 * @param {string} prop
 * @returns {boolean}
 */
function hasProperty(s, prop) {
	return Object.prototype.hasOwnProperty.call(s, prop)
}

runEntrypoint(CaptivateInstance, UpgradeScripts)
