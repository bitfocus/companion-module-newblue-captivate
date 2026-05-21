const fs = require('fs')
const { execSync } = require('child_process')

const packageJsonPath = './package.json'
const manifestJsonPath = './companion/manifest.json'

// Read both files
const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const manifestData = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'))

// Check if versions match
if (packageData.version !== manifestData.version) {
	console.error(`Version mismatch: package.json (${packageData.version}) vs manifest.json (${manifestData.version})`)
	throw new Error('Version mismatch between package.json and manifest.json')
}

const currentVersion = packageData.version
console.log(`Current version: ${currentVersion}`)

// Increment patch version (third element)
const version = currentVersion.split('.')
if (version.length !== 3) {
	console.error(`Invalid version format: ${currentVersion}. Expected format: x.y.z`)
	throw new Error('Invalid version format')
}

version[2] = parseInt(version[2]) + 1
const newVersion = version.join('.')

console.log(`Bumping version from ${currentVersion} to ${newVersion}`)

// Update package.json
packageData.version = newVersion
fs.writeFileSync(packageJsonPath, JSON.stringify(packageData, null, '\t') + '\n')
console.log('Updated package.json')

// Update manifest.json
manifestData.version = newVersion
fs.writeFileSync(manifestJsonPath, JSON.stringify(manifestData, null, '\t') + '\n')
console.log('Updated manifest.json')

// Create git tag
const tagName = `v${newVersion}`
try {
	// Stage the changed files
	execSync('git add package.json companion/manifest.json', { stdio: 'inherit' })
	console.log('Staged version files')

	// Commit the version bump
	execSync(`git commit -m "Bump version to ${newVersion}"`, { stdio: 'inherit' })
	console.log('Committed version bump')

	// Create and push the tag
	execSync(`git tag ${tagName}`, { stdio: 'inherit' })
	console.log(`Created git tag: ${tagName}`)

	// Optionally push the tag (uncomment if you want to push automatically)
	execSync(`git push origin ${tagName}`, { stdio: 'inherit' })
	execSync(`git push bitfocus ${tagName}`, { stdio: 'inherit' })
	console.log(`Pushed tag: ${tagName}`)
} catch (error) {
	console.error('Git operation failed:', error.message)
	throw error
}

console.log('Version bump complete!')
