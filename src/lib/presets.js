//@ts-check
class PresetDefinition {
	/** @type {'button'} */
	type = 'button'

	/** @type {string} */
	category = ''

	/** @type {string} */
	name = ''

	/** @type {import("@companion-module/base").CompanionButtonStyleProps?} */
	style

	/** @type {import("@companion-module/base").CompanionButtonStyleProps?} */
	previewStyle

	/** @type {import("@companion-module/base").CompanionButtonPresetOptions?} */
	options

	/** @type {import("@companion-module/base").CompanionPresetFeedback[]} */
	feedbacks = []

	/** @type {import("@companion-module/base").CompanionButtonStepActions[]} */
	steps = []

	constructor(category, name, style, feedbacks = [], steps = [], previewStyle = null, options = null) {
		this.category = category
		this.name = name
		this.style = style
		this.feedbacks = feedbacks
		this.steps = steps
		this.previewStyle = previewStyle
		this.options = options
	}

	/** @return {Promise<PresetDefinition>} */
	static async fromV2(preset, imageCache) {
		const p = new PresetDefinition()
		p.name = preset.label
		p.category = preset.category

		// The style is defined by the old `bank` field. Get only what we need from it.
		const { alignment = 'center', bgcolor, color, pngalignment, show_topbar = null, size, text, png64 } = preset.bank
		p.style = { alignment, bgcolor, color, pngalignment, size, text }
		if (show_topbar !== null) {
			p.style.show_topbar = show_topbar // use default unless it has been explicitly set to true or false
		}

		if (png64 !== undefined) {
			p.style.png64 = png64
		}

		// get the image data
		if (!png64 && preset.bank?.imageName) {
			const imageData = await imageCache.getImageData(preset.bank.imageName)
			if (imageData) {
				p.style.png64 = imageData
			}
		}

		// convert v2 actions to v3 steps
		p.steps = preset.actions.map((action) => ({
			down: [
				{
					actionId: action.action,
					options: action.options,
				},
			],
			up: [], // Assuming no actions on 'up' for simplicity; modify as needed
		}))

		// if this was an old-style latch action, add the release actions as more steps
		if (preset.bank.latch) {
			p.steps = preset.release_actions.map((action) => ({
				down: [
					{
						actionId: action.action,
						options: action.options,
					},
				],
				up: [], // Assuming no actions on 'up' for simplicity; modify as needed
			}))
		}

		// migrate type -> feedbackId
		p.feedbacks = preset.feedbacks.map((feedback) => {
			const { type, ...rest } = feedback
			const fb = {
				...rest,
				feedbackId: type,
			}

			// handle boolean types
			if (type.match(/\.boolean\./)) {
				fb.style = {
					color: rgb(0, 0, 0),
					bgcolor: rgb(255, 255, 0),
				}
			}

			return fb
		})

		return p
	}
}

/** These functions will be included in the main class, so it's safe to use "this" */
module.exports = {
	async publishPresets(response) {
		this.debug('--------------- publishing presets to companion -----------------------')

		if (response !== undefined) {
			const presets = []
			for (const preset of response) {
				// remap custom images
				const upgradedPreset = await PresetDefinition.fromV2(preset, this.cache)
				// console.dir(upgradedPreset, { depth: 10 })
				presets.push(upgradedPreset)
				// for debugging
				const { category, name, steps } = upgradedPreset
				let step = 'none'
				if (steps.length > 0) {
					if (steps[0].down?.length > 0) {
						step = steps[0].down[0].actionId
					}
				}
				this.debug(`publishing preset: [${category} - ${name}] with first step: [${step}]`)
				// this.debug('preset details', { preset: upgradedPreset })
			}

			/**
			 * Most of our presets are defined by the Automation Startup script that runs inside our
			 * NodeJS server (or in the Automation controller in older Captivate versions).
			 *
			 * However, we can also make this module do even more by interfacing with the Captivate API
			 * directly. The following code will add some extra presets that are not defined in the Automation
			 * Startup sequence.
			 *
			 *
			 * REMOVED FOR NOW: The extra presets were confusing to some users.
			 * For now, we are removing the features from the presets, but the actions, feedbacks, and variables
			 * will remain in the system in case an advanced user wants to use them.
			 *
			 */
			// this.addExtraPresets(presets)

			// this.debug('publishing presets', presets);
			this.setPresetDefinitions(presets)
		}
	},

	// add presets that aren't defined in the captivate binary but work by making direct API calls
	addExtraPresets(presets) {
		const defaultButtonColor = this.rgb(0, 0, 40)
		const setButtonColor = this.rgb(0, 0, 80)
		const toggleButtonColor = this.rgb(80, 80, 80)
		const alertButtonColor = this.rgb(200, 0, 0)

		// default button style leaves show_topbar out
		const varButtonStyle = {
			alignment: 'center:center',
			bgcolor: defaultButtonColor,
			color: '16777215',
			pngalignment: 'center:center',
			size: '10',
		}

		for (const title of this.titles) {
			const titlename = title.name
			for (const variable of title.variables) {
				// don't create presets for color or image variables
				if (variable.type === 'image' || variable.type === 'color') continue
				const varname = variable.variable
				// let varLabel = `${title.name}: ${variable.variable}`
				const varid = this.makeVarDefinition(title, variable.variable).variableId
				const fullInternalVarName = `$(${this.instanceName}:${varid})`
				const varNameWithTitleVarValue = `${varname}\\n${fullInternalVarName}\\n${title.name}`
				const varNameWithTitle = `${varname}\\n\\n${title.name}`

				// add a variable display button for every title's variables
				presets.push(
					new PresetDefinition(
						`Variables: ${titlename}`,
						`A button with the name and value of a variable for but preset actions or feedbacks.`,
						{ ...varButtonStyle, text: varNameWithTitleVarValue },
						[],
						[],
					),
				)

				// add a variable set value button for every title's variable
				let actionId = this.makeCustomActionId('variableSetAction')
				presets.push(
					new PresetDefinition(
						`Variables: ${titlename}`,
						`Set the variable to a specified value.`,
						{ ...varButtonStyle, text: `Set\n${varNameWithTitleVarValue}`, bgcolor: setButtonColor },
						[],
						[
							{
								down: [
									{
										actionId,
										options: {
											varid,
											varvalue: '',
											action: 'update',
										},
									},
								],
								up: [],
							},
						],
					),
				)

				// add a variable toggle button for every title's visibility variables
				if (variable.type == 'visible') {
					const feedbackId = this.makeCustomFeedbackId('boolean', 'isVisible')
					actionId = this.makeCustomActionId('variableToggleAction')
					presets.push(
						new PresetDefinition(
							`Variables: ${titlename}`,
							`Toggle a variable's visibility`,
							{ ...varButtonStyle, text: 'Toggle\n' + varNameWithTitle, bgcolor: toggleButtonColor },
							[
								{
									feedbackId,
									style: {
										color: this.rgb(0, 0, 0),
										bgcolor: this.rgb(255, 255, 0),
									},
									options: {
										variable: fullInternalVarName,
									},
								},
							],
							[
								{
									down: [
										{
											actionId,
											options: {
												varid,
												action: 'update',
											},
										},
									],
									up: [],
								},
							],
						),
					)

					// also add a timed alert action
					actionId = this.makeCustomActionId('variableSetAction')
					presets.push(
						new PresetDefinition(
							`Variables: ${titlename}`,
							`Turn a variable on and off again after a set delay`,
							{ ...varButtonStyle, text: 'Alert\n' + varNameWithTitle, bgcolor: alertButtonColor },
							[
								{
									feedbackId,
									style: {
										color: this.rgb(0, 0, 0),
										bgcolor: this.rgb(255, 255, 0),
									},
									options: {
										variable: fullInternalVarName,
									},
								},
							],
							[
								{
									down: [
										{
											actionId,
											options: {
												varid,
												varvalue: '1',
												action: 'update',
											},
										},
										{
											actionId,
											options: {
												varid,
												varvalue: '',
												action: 'update',
											},
											delay: 4000,
										},
									],
									up: [],
								},
							],
						),
					)
				}

				// add a variable increment button for every title's numeric variables
				if (variable.type == 'text' && variable.value.trim() != '' && !isNaN(variable.value)) {
					actionId = this.makeCustomActionId('variableIncrementAction')
					presets.push(
						new PresetDefinition(
							`Variables: ${titlename}`,
							`Increment variable value by a custom amount.`,
							{ ...varButtonStyle, text: 'Increment\n' + varNameWithTitleVarValue, bgcolor: setButtonColor },
							[],
							[
								{
									down: [
										{
											actionId,
											options: {
												varid,
												varincrement: 1,
												action: 'update',
											},
										},
									],
									up: [],
								},
							],
						),
					)
				}
			}
		}
	},

	initPresets() {
		this.requestCompanionDefinition('presets')
			.then((response) => {
				// console.log('latest presets loaded from captivate', response)
				this.publishPresets(response)
			})
			.catch((e) => {
				console.error('error requesting presets', e)
			})
	},
}

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
