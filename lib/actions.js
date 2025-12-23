/** These functions will be included in the main class, so it's safe to use "this" */

/** sample action
 * {
    "label": "Playout: Play Action", // @deprecated
		"name": "Play Action",
		"description": "Play Action",
		"target": "newblue.core.playout~global~newblue.core.playout.native.playAction",
    "options": [
      {
        "choices": [
          {
            "id": "auto",
            "label": "Animate In / Animate Out"
          },
          {
            "id": "autoin",
            "label": "Animate In / Cut Out"
          },
          {
            "id": "autoout",
            "label": "Cut In / Animate Out"
          },
          {
            "id": "take",
            "label": "Cut In / Cut Out"
          },
          {
            "id": "inout",
            "label": "Animate In Or Animate Out"
          }
        ],
        "default": "auto",
        "id": "command",
        "label": "Play command",
        "tooltip": "Play command behavior",
        "type": "dropdown"
      }
    ]
  }
*/
module.exports = {
	async publishActions(response) {
		this.debug('---------- publishing actions to companion ------------------')
		if (response != undefined) {
			const actions = {}
			response.forEach((actionData) => {
				this.debug('publishing action: ' + actionData.target)

				// target is the companion/captivate id of the action
				const { target, label, name, description, options, isHidden } = actionData

				const definition = {
					name: name || label || description,
					description: description || label,
					options: options ?? [],
				}
				if (isHidden) {
					definition.isVisibleExpression = 'bool(0)'
				}

				// since 3.0, actions need an explicit callback
				definition.callback = async (event) => {
					// alternatively, event.actionId = target
					this.scheduler._cmp_v1_performAction(target, event.options)
				}

				actions[target] = definition
			})

			// also add our Advanced API actions
			this.addCustomVariableAction(actions, 'Update: Set Variable', 'variableSetAction')
			this.addCustomVariableAction(actions, 'Update: Toggle Variable', 'variableToggleAction')
			this.addCustomVariableAction(actions, 'Update: Increment Variable', 'variableIncrementAction')

			//console.log("actions", actions);
			this.setActionDefinitions(actions)
		}
	},

	setupActions() {
		this.requestCompanionDefinition('actions')
			.then((response) => this.publishActions(response))
			.catch((e) => {
				this.log('error', 'error requesting actions: ' + e)
			})
	},

	/**
	 * Defines additional actions based on the titles and variables in the current Captivate project.
	 *
	 * @param {object} actions current actions object
	 * @param {string} name the name of this action
	 * @param {string} shortId the part at the end of the full newblue action identifier
	 */
	async addCustomVariableAction(actions, name, shortId) {
		// setup a command to set a variable
		const varChoices = []

		for (let title of this.titles) {
			for (let variable of title.variables) {
				if (shortId == 'variableToggleAction' && variable.type !== 'visible') continue
				let varname = variable.variable
				let { variableId } = this.makeVarDefinition(title, varname)
				let choice = { id: variableId, label: `${title.name}: ${varname}` }
				varChoices.push(choice)
			}
		}

		// only visible to companion, so it doesn't have to follow the entire newblue action schema
		// const actionId = 'newblue.core.advanced~global~newblue.core.advanced.js.' + shortId
		const actionId = this.makeCustomActionId(shortId)
		const action = {
			name,
			options: [],
		}
		actions[actionId] = action

		// default options for when we haven't grabbed any titles.
		if (varChoices.length == 0) {
			action.options = [
				{
					id: 'titlename',
					type: 'textinput',
					label: 'Name of Title to Target',
					tooltip: 'This must match the name of a title in your project',
				},
				{
					id: 'varname',
					type: 'textinput',
					label: 'Name of Variable to Set',
					tooltip: "If the variable doesn't exist in your title, nothing will happen.",
				},
			]
		} else {
			action.options = [
				{
					id: 'varid',
					type: 'dropdown',
					label: 'Variable to Set',
					choices: varChoices,
					default: varChoices[0].id,
				},
			]
		}

		switch (shortId) {
			case 'variableSetAction':
				action.options.push({
					id: 'varvalue',
					type: 'textinput',
					label: 'Value of Variable to Set',
					tooltip: 'To trigger a visibility variable, set to anything for `visible` and leave empty for `invisible`.',
					useVariables: true,
				})
				break
			case 'variableIncrementAction':
				action.options.push({
					id: 'varincrement',
					type: 'number',
					label: 'Increment Value',
					tooltip: 'To subtract a value, use a negative number.',
					default: 1,
				})
				break
			default:
				break
		}

		// always include the 'action'
		action.options.push({
			id: 'action',
			type: 'dropdown',
			label: 'Update Type',
			tooltip: 'Which type of update do you want to use?',
			choices: [
				{
					id: 'update',
					label: 'Animated Update',
				},
				{
					id: 'still',
					label: 'Immediate Update',
				},
			],
			default: 'update',
		})

		action.callback = async (action) => {
			// console.log('user used action:')
			// console.dir(action, {depth: 5})

			// if we have no titles, the first two are populated
			let varname
			let varid
			let title
			let prevValue
			let newValue

			// if the action was built before we had titles, we get these values
			if (action.options.titlename) {
				title = this.titlesByName[action.options.titlename]
				varname = action.options.varname
				varid = this.makeVarDefinition(title, varname).variableId
			}

			// if we do have titles, we should get this value
			if (action.options.varid) {
				varid = action.options.varid
				let varDetails = this.varData[varid]
				title = varDetails.title
				varname = varDetails.varname
			}

			prevValue = this.varData[varid]?.value ?? ''

			switch (shortId) {
				case 'variableSetAction':
					// parse variables from the input text
					newValue = await this.parseVariablesInString(action.options.varvalue ?? '')
					break
				case 'variableIncrementAction':
					newValue = makeNumber(action.options.varincrement) + makeNumber(prevValue)
					break
				case 'variableToggleAction':
					newValue = prevValue ? '' : '1'
					break
				default:
					break
			}

			// update the internal and the companion variables
			// console.log({title: title.name, varname, newValue})
			this.setVar({ varid, value: newValue })
			// console.log({title: title.name, varname, varid, prevValue, newValue, varData: this.varData})

			// send to captivate
			// console.log(action.options.action, '', title.id, {[varname]: newValue});
			this.sp.scheduleAction(action.options.action, '', title.id, { [varname]: newValue })
		}
	},
}

function makeNumber(v, asFloat = false) {
	if (!v || isNaN(v)) return 0
	return asFloat ? parseFloat(v) : parseInt(v)
}
