module.exports = {
	getConfigFields() {
		return [
			// {
			//     type: 'text',
			//     id: 'info',
			//     width: 12,
			//     label: 'About NewBlue Companion Plugin for Captivate',
			//     value: 'This module is used to control NewBlue Captivate .'
			// },
			{
				type: 'bonjour-device',
				id: 'bonjour_host',
				label: 'Captivate AutoDiscovery',
				width: 12,
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target Hostname/IP',
				tooltip: 'The IP or hostname of your Captivate instance',
				width: 6,
				isVisible: (options) => !options['bonjour_host'],
				default: '127.0.0.1',
			},
			{
				type: 'number',
				label: 'Port',
				id: 'port',
				min: 1,
				max: 65535,
				default: 9023,
				isVisible: (options) => !options['bonjour_host'],
			},
			{
				type: 'static-text',
				id: 'host-filler',
				width: 6,
				label: '',
				isVisible: (options) => !!options['bonjour_host'],
				value: '',
			},
		]
	},
}
