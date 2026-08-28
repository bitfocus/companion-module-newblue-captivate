const crypto = require('crypto')
const { Jimp } = require('jimp')

class TimestampedData {
	get expired() {
		const age = Date.now() - this.timestamp
		return this.max_age > 0 && age > this.max_age
	}
	constructor(data, max_age = 0) {
		this.data = data
		this.max_age = max_age
		this.timestamp = Date.now()
	}
}

class LocalCache {
	_data_cache = new Map()
	_image_cache = new Map()
	_promises = new Map()
	max_age = 1000

	setCacheLifetime(max_age) {
		this.max_age = max_age
	}

	/**
	 * A hash will be created from the stringified object.
	 *
	 * @param {string} key the key is usually the full actor/feedback id (ids separated by '~')
	 * @param {object} options
	 * @returns
	 */
	makeKeyWithOptions(key, options) {
		let cacheKey = key

		if (options && Object.keys(options).length) {
			const optionsHash = crypto.createHash('md5').update(JSON.stringify(options)).digest('hex')
			cacheKey = `${cacheKey}+${optionsHash}`
			// cacheKey = `${cacheKey}+${JSON.stringify(options)}`
		}

		return cacheKey
	}

	removeKeysWithPrefix(prefix) {
		for (const key of this._data_cache.keys()) {
			if (key.startsWith(prefix)) this._data_cache.delete(key)
		}
	}

	storeFromFullId(actorFeedbackId, options, state, expires_after = 1000) {
		const tsData = new TimestampedData(state, expires_after)
		const cachekey = this.makeKeyWithOptions(actorFeedbackId, options)
		this._data_cache.set(cachekey, tsData)
		return cachekey
	}

	store(actorId, feedbackId, options, state, expires_after = 1000) {
		const afid = [actorId, feedbackId].join('~')
		return this.storeFromFullId(afid, options, state, expires_after)
	}

	getFromFullId(actorFeedbackId, options) {
		const cachekey = this.makeKeyWithOptions(actorFeedbackId, options)
		if (this._data_cache.get(cachekey)?.expired) {
			this._data_cache.delete(cachekey)
		}
		return [cachekey, this._data_cache.get(cachekey)?.data]
	}

	get(actorId, feedbackId, options) {
		const afid = [actorId, feedbackId].join('~')
		return this.getFromFullId(afid, options)
	}

	/**
	 *
	 * @param {string} fullId
	 * @param {any} options
	 * @param {() => ({[key: string]: string|number|boolean})} ifEmptyFunction
	 * @returns {Promise<[{[key: string]: string|number|boolean}, boolean]>} the second value will be true if it found in the cache
	 */
	async getPromisedFromFullId(fullId, options, ifEmptyFunction) {
		const [cachekey, cachedata] = this.getFromFullId(fullId, options)
		if (cachedata) return Promise.resolve([cachedata, true])

		if (this._promises.has(cachekey)) {
			return this._promises.get(cachekey)
		}

		const promise = Promise.resolve(ifEmptyFunction())
			.then((data) => {
				this._data_cache.set(cachekey, new TimestampedData(data, this.max_age))
				return [data, false]
			})
			.finally(() => {
				this._promises.delete(cachekey)
			})

		this._promises.set(cachekey, promise)
		return promise
	}

	removeFromFullId(actorFeedbackId, options) {
		const cachekey = this.makeKeyWithOptions(actorFeedbackId, options)
		this._data_cache.delete(cachekey)
	}

	remove(actorId, feedbackId, options) {
		const afid = [actorId, feedbackId].join('~')
		this.removeFromFullId(afid, options)
	}

	/**
	 *
	 * @param {string} namePathOrUrl
	 * @param {string} param1.label // unused for now, but it was in the previous code, so still here
	 * @param {number} param1.width // all buttons are 72 pixels wide
	 * @param {number} param1.height // if you are showing the topbar, this should be 72 - 14 = 58
	 * @returns {Promise<string|undefined>} base64 image (with mime type)
	 */
	async getImageData(namePathOrUrl, { label = 'hello', width = 72, height = 72 } = {}) {
		// console.log('getCachedImageData', namePathOrUrl)
		if (this._image_cache.has(namePathOrUrl)) {
			return this._image_cache.get(namePathOrUrl)
		}

		let image
		try {
			image = await Jimp.read(namePathOrUrl) // jimp can do urls, paths, and base64
		} catch (e) {
			console.log(e)
			console.error('Error loading image:', namePathOrUrl)
			return undefined
		}

		if (image) {
			image.cover({ w: width, h: height })
			if (label) {
				// for future use... this is how you fill an area with alpha so that
				// our nice blue background can shine through
				// fill rectangle with black
				// image.scan(0, 72 - 14, 72, 14, function (x, y, offset) {
				// 	this.bitmap.data.writeUInt32BE(0x00000088, offset, true)
				// })
			}
			const base64 = await image.getBase64('image/png')
			this._image_cache.set(namePathOrUrl, base64)
			return base64
		}
		return undefined
	}

	setImageData(name, data) {
		this._image_cache.set(name, data)
	}
}

module.exports = { LocalCache }
