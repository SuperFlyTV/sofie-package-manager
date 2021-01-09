import { PackageOrigin } from '@sofie-automation/blueprints-integration'
import { Expectation } from '../expectationApi'
import * as path from 'path'
import * as fs from 'fs'
import { promisify } from 'util'
import { roboCopyFile } from '../lib/robocopy'
import { GenericWorker, IWorkInProgress, WorkInProgress } from '../worker'

const fsStat = promisify(fs.stat)
const fsAccess = promisify(fs.access)
const fsUnlink = promisify(fs.unlink)

export class NodeJSWorker extends GenericWorker {
	private corePackageInfoInterface = new TMPCorePackageInfoInterface() // todo

	doYouSupportExpectation(exp: Expectation.Any): boolean {
		if (exp.type === Expectation.Type.MEDIA_FILE_COPY || exp.type === Expectation.Type.MEDIA_FILE_SCAN) {
			return true
		}
		return false
	}
	isExpectationReadyToStartWorkingOn(exp: Expectation.Any): Promise<{ ready: boolean; reason?: string }> {
		switch (exp.type) {
			case Expectation.Type.MEDIA_FILE_COPY:
				return MediaFileCopy.isExpectationReadyToStartWorkingOn(exp)
			case Expectation.Type.MEDIA_FILE_SCAN:
				return MediaFileScan.isExpectationReadyToStartWorkingOn(exp)
			default:
				throw new Error(`Unsupported expectation.type "${exp.type}"`)
		}
	}
	isExpectationFullfilled(exp: Expectation.Any): Promise<{ fulfilled: boolean; reason?: string }> {
		switch (exp.type) {
			case Expectation.Type.MEDIA_FILE_COPY:
				return MediaFileCopy.isExpectationFullfilled(exp)
			case Expectation.Type.MEDIA_FILE_SCAN:
				return MediaFileScan.isExpectationFullfilled(exp, this.corePackageInfoInterface)
			default:
				throw new Error(`Unsupported expectation.type "${exp.type}"`)
		}
	}
	workOnExpectation(exp: Expectation.Any): Promise<IWorkInProgress> {
		switch (exp.type) {
			case Expectation.Type.MEDIA_FILE_COPY:
				return MediaFileCopy.workOnExpectation(exp)
			case Expectation.Type.MEDIA_FILE_SCAN:
				return MediaFileScan.workOnExpectation(exp, this.corePackageInfoInterface)
			default:
				throw new Error(`Unsupported expectation.type "${exp.type}"`)
		}
	}
	removeExpectation(exp: Expectation.Any): Promise<{ removed: boolean; reason?: string }> {
		switch (exp.type) {
			case Expectation.Type.MEDIA_FILE_COPY:
				return MediaFileCopy.removeExpectation(exp)
			case Expectation.Type.MEDIA_FILE_SCAN:
				return MediaFileScan.removeExpectation(exp, this.corePackageInfoInterface)
			default:
				throw new Error(`Unsupported expectation.type "${exp.type}"`)
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace MediaFileCopy {
	export async function isExpectationReadyToStartWorkingOn(
		exp: Expectation.MediaFileCopy
	): Promise<{ ready: boolean; reason?: string }> {
		const lookupOrigin = await lookupExpOrigin(exp)

		return {
			ready: !lookupOrigin.errorReason,
			reason: lookupOrigin.errorReason,
		}
	}
	export async function isExpectationFullfilled(
		exp: Expectation.MediaFileCopy
	): Promise<{ fulfilled: boolean; reason?: string }> {
		/** undefined if all good, error string otherwise */
		let reason: undefined | string = 'Unknown fulfilled error'

		const fullPath = path.join(exp.endRequirement.location.folderPath, exp.endRequirement.content.filePath)

		try {
			await fsAccess(fullPath, fs.constants.R_OK)
			// The file exists
		} catch (err) {
			// File is not readable
			return { fulfilled: false, reason: `File does not exist: ${err.toString()}` }
		}

		// check that the file is of the right version:
		const stat = await fsStat(fullPath)
		reason = compareFileVersion(stat, exp.endRequirement.version)

		if (reason) return { fulfilled: false, reason }

		const lookupOrigin = await lookupExpOrigin(exp)
		// TODO: how to handle if the origin is gone? is it still fullfilled then?
		if (lookupOrigin && !lookupOrigin.errorReason && lookupOrigin.foundOriginPath) {
			const originStat = await fsStat(lookupOrigin.foundOriginPath)

			if (stat.size !== originStat.size) {
				reason = `File size differ from origin (${originStat.size}, ${stat.size})`
			}
			if (stat.mtimeMs !== originStat.mtimeMs) {
				reason = `Modified time differ from origin (${originStat.mtimeMs}, ${stat.mtimeMs})`
			}
			// TODO: check other things?
		}

		return { fulfilled: !reason, reason }
	}
	export async function workOnExpectation(exp: Expectation.MediaFileCopy): Promise<IWorkInProgress> {
		// Copies the file from Origin to Location

		const lookupOrigin = await lookupExpOrigin(exp)

		if (lookupOrigin.errorReason) {
			throw new Error(`Can't start working due to: ${lookupOrigin.errorReason}`)
		}
		if (!lookupOrigin.foundOriginPath) {
			throw new Error(`No origin path found!`)
		}

		const targetPath = path.join(exp.endRequirement.location.folderPath, exp.endRequirement.content.filePath)

		const workInProgress = new WorkInProgress(async () => {
			// on cancel
			copying.cancel()
			// todo: should we remove the target file?
		})
		const copying = roboCopyFile(lookupOrigin.foundOriginPath, targetPath, (progress: number) => {
			workInProgress._reportProgress(progress)
		})

		copying
			.then(() => {
				workInProgress._reportComplete(undefined)
			})
			.catch((err) => {
				workInProgress._reportError(err)
			})

		return workInProgress
	}
	export async function removeExpectation(
		exp: Expectation.MediaFileCopy
	): Promise<{ removed: boolean; reason?: string }> {
		// Remove the file on the location

		const targetPath = path.join(exp.endRequirement.location.folderPath, exp.endRequirement.content.filePath)

		try {
			await fsAccess(targetPath, fs.constants.R_OK)
			// The file exists
		} catch (err) {
			// File is not writeable
			return { removed: false, reason: `Cannot write to file: ${err.toString()}` }
		}

		try {
			await fsUnlink(targetPath)
		} catch (err) {
			return { removed: false, reason: `Cannot remove file: ${err.toString()}` }
		}

		return { removed: true, reason: '' }
	}

	// eslint-disable-next-line no-inner-declarations
	async function lookupExpOrigin(exp: Expectation.MediaFileCopy) {
		/** undefined if all good, error string otherwise */
		let errorReason: undefined | string = 'No origin found'
		let foundOriginPath: undefined | string = undefined

		// See if the file is available at any of the origins:
		for (const origin of exp.startRequirement.origins) {
			if (origin.type === PackageOrigin.OriginType.LOCAL_FOLDER) {
				errorReason = undefined

				const folderPath = origin.folderPath
				if (!folderPath) {
					errorReason = `Origin folder path not set`
					continue // Maybe next origin works?
				}
				const filePath = origin.filePath || exp.endRequirement.content.filePath
				if (!filePath) {
					errorReason = `Origin file path not set`
					continue // Maybe next origin works?
				}

				const fullPath = path.join(folderPath, filePath)

				try {
					await fsAccess(fullPath, fs.constants.R_OK)
					// The file exists
				} catch (err) {
					// File is not readable
					errorReason = `Not able to read file: ${err.toString()}`
				}
				if (errorReason) continue // Maybe next origin works?

				// Check that the file is of the right version:
				const stat = await fsStat(fullPath)
				errorReason = compareFileVersion(stat, exp.endRequirement.version)

				if (!errorReason) {
					// All good, no need to look further
					foundOriginPath = fullPath
					break
				}
			} else {
				throw new Error(`Unsupported MediaFile origin.type "${origin.type}"`)
			}
		}

		// Also check that the target location is writeable:
		const targetPath = exp.endRequirement.location.folderPath
		try {
			await fsAccess(targetPath, fs.constants.W_OK)
			// Is writeable
		} catch (err) {
			errorReason = `Not able to write to location. ${err.toString()}`
		}

		if (errorReason) foundOriginPath = undefined
		return { foundOriginPath, errorReason }
	}
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace MediaFileScan {
	export async function isExpectationReadyToStartWorkingOn(
		exp: Expectation.MediaFileScan
	): Promise<{ ready: boolean; reason?: string }> {
		if (exp.startRequirement.location.type === PackageOrigin.OriginType.LOCAL_FOLDER) {
			const fullPath = path.join(exp.startRequirement.location.folderPath, exp.startRequirement.content.filePath)

			try {
				await fsAccess(fullPath, fs.constants.R_OK)
				// The file exists
			} catch (err) {
				return { ready: false, reason: `File does not exist: ${err.toString()}` }
			}

			// check that the file is of the right version:
			const stat = await fsStat(fullPath)
			const errorReason = compareFileVersion(stat, exp.startRequirement.version)
			if (errorReason) return { ready: false, reason: errorReason }

			return { ready: true, reason: '' }
		} else {
			throw new Error(`Unsupported location type "${exp.startRequirement.location.type}"`)
		}

		// const lookupOrigin = await lookupExpOrigin(exp)
	}
	export async function isExpectationFullfilled(
		exp: Expectation.MediaFileScan,
		corePackageInfo: TMPCorePackageInfoInterface
	): Promise<{ fulfilled: boolean; reason?: string }> {
		/** undefined if all good, error string otherwise */
		// let reason: undefined | string = 'Unknown fulfill error'

		if (exp.endRequirement.location.type === PackageOrigin.OriginType.CORE_PACKAGE_INFO) {
			if (
				await corePackageInfo.hasRecord(
					exp.startRequirement.location,
					exp.startRequirement.content,
					exp.startRequirement.version
				)
			) {
				return { fulfilled: true, reason: '' }
			}
		} else {
			throw new Error(`Unsupported location type "${exp.endRequirement.location.type}"`)
		}

		return { fulfilled: true, reason: '' }
	}
	export async function workOnExpectation(
		_exp: Expectation.MediaFileScan,
		_corePackageInfo: TMPCorePackageInfoInterface
	): Promise<IWorkInProgress> {
		const workInProgress = new WorkInProgress(async () => {
			// on cancel
			// copying.cancel()
			// todo: should we remove the target file?
		})

		workInProgress._reportComplete(undefined)
		// workInProgress._reportError(err)

		return workInProgress
	}
	export async function removeExpectation(
		_exp: Expectation.MediaFileScan,
		_corePackageInfo: TMPCorePackageInfoInterface
	): Promise<{ removed: boolean; reason?: string }> {
		// todo: remove from corePackageInfo
		// corePackageInfo

		return { removed: true, reason: '' }
	}
}

function compareFileVersion(stat: fs.Stats, version: Expectation.MediaFileVersion): undefined | string {
	let errorReason: string | undefined = undefined
	if (version.fileSize && stat.size !== version.fileSize) {
		errorReason = `Origin file size differ (${version.fileSize}, ${stat.size})`
	}
	if (version.modifiedDate && stat.mtimeMs * 1000 !== version.modifiedDate) {
		errorReason = `Origin modified date differ (${version.modifiedDate}, ${stat.mtimeMs * 1000})`
	}
	if (version.checksum) {
		// TODO
		throw new Error('Checksum not implemented yet')
	}
	return errorReason
}

class TMPCorePackageInfoInterface {
	async hasRecord(
		_location: PackageOrigin.LocalFolder,
		_content: { filePath: string },
		_version: Expectation.MediaFileVersion
	): Promise<boolean> {
		return true
		throw new Error('Method not implemented.')
	}
}
