/* eslint-disable node/no-unpublished-require */
const promisify = require('util').promisify
const cp = require('child_process')
const path = require('path')
// const nexe = require('nexe')
const exec = promisify(cp.exec)

const fse = require('fs-extra')
const mkdirp = require('mkdirp')

const fseCopy = promisify(fse.copy)

/*
	Due to nexe not taking into account the packages in the mono-repo, we're doing a hack,
	copying the packages into node_modules, so that nexe will include them.
*/
const basePath = process.cwd()
const packageJson = require(path.join(basePath, '/package.json'))
// const outputDirectory = path.join(basePath, './deploy/')
// const executableName = process.argv[2]
// if (!executableName) {
// 	throw new Error(`Argument for the output executable file name not provided`)
// }

;(async () => {
	log(`Collecting dependencies for ${packageJson.name}...`)
	// List all Lerna packages:
	const list = await exec('yarn lerna list -a --json')
	const str = list.stdout
		.replace(/^yarn run .*$/gm, '')
		.replace(/^\$.*$/gm, '')
		.replace(/^Done in.*$/gm, '')

	const packages = JSON.parse(str)

	await mkdirp(path.join(basePath, 'node_modules'))

	// Copy the packages into node_modules:
	const copiedFolders = []
	let ps = []
	for (const package0 of packages) {
		if (package0.name.match(/boilerplate/)) continue
		if (package0.name.match(packageJson.name)) continue

		const target = path.resolve(path.join(basePath, 'tmp_packages_for_build', package0.name))
		log(`  Copying: ${package0.name} to ${target}`)

		// log(`    ${package0.location} -> ${target}`)
		ps.push(fseCopy(package0.location, target))

		copiedFolders.push(target)
	}

	await Promise.all(ps)
	ps = []

	log(`...done!`)
})().catch(log)

function log(...args) {
	// eslint-disable-next-line no-console
	console.log(...args)
}
