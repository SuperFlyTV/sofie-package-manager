import {
	ExpectedPackageStatusAPI,
	AccessorOnPackage,
	PackageContainerOnPackage,
} from '@sofie-automation/blueprints-integration'

/*
 * This file contains definitions for Expectations, the internal datastructure upon which the Package Manager operates.
 */

/** An Expectation defines an "expected end state". The Package Manages takes these as input, then works towards fullfilling the expectations. */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Expectation {
	/** Generic Expectation, used as "Any Exopectation" */
	export type Any =
		| FileCopy
		| MediaFileScan
		| MediaFileDeepScan
		| MediaFileThumbnail
		| MediaFilePreview
		| QuantelClipCopy

	/** Defines the Expectation type, used to separate the different Expectations */
	export enum Type {
		FILE_COPY = 'file_copy',
		MEDIA_FILE_SCAN = 'media_file_scan',
		MEDIA_FILE_DEEP_SCAN = 'media_file_deep_scan',
		MEDIA_FILE_THUMBNAIL = 'media_file_thumbnail',
		MEDIA_FILE_PREVIEW = 'media_file_preview',

		QUANTEL_CLIP_COPY = 'quantel_clip_copy',
	}

	/** Common attributes of all Expectations */
	export interface Base {
		id: string
		type: Type

		/** Id of the ExpectationManager the expectation was created from */
		managerId: string

		/** Expectation priority. Lower will be handled first */
		priority: number

		/** A list of which expectedPackages that resultet in this expectation */
		fromPackages: {
			/** ExpectedPackage id */
			id: string
			/** Reference to the contentVersionHash of the ExpectedPackage, used to reference the expected content+version of the Package */
			expectedContentVersionHash: string
		}[]

		/** Contains info for reporting back status to Core. null = don't report back */
		statusReport: Omit<ExpectedPackageStatusAPI.WorkBaseInfo, 'fromPackages'> & {
			/** Set to true to enable reporting back statuses to Core */
			sendReport: boolean
		}

		/** Contains info for determining that work can start (and is used to perform the work) */
		startRequirement: {
			sources: PackageContainerOnPackage[]
		}
		/** Contains info for determining that work can end (and is used to perform the work) */
		endRequirement: {
			targets: PackageContainerOnPackage[]
			content: any
			version: any
		}
		/** Contains info that can be used during work on an expectation. Changes in this does NOT cause an invalidation of the expectation. */
		workOptions: any // {}
		/** Reference to another expectation.
		 * Won't start until ALL other expectations are fullfilled
		 */
		dependsOnFullfilled?: string[]
		/** Reference to another expectation.
		 * On fullfillement, this will be triggered immediately.
		 */
		triggerByFullfilledIds?: string[]
	}

	/** Defines a File Copy Expectation. A File is to be copied from one of the Sources, to the Target. */
	export interface FileCopy extends Base {
		type: Type.FILE_COPY

		startRequirement: {
			sources: SpecificPackageContainerOnPackage.File[]
		}
		endRequirement: {
			targets: [SpecificPackageContainerOnPackage.File]
			content: {
				filePath: string
			}
			version: Version.ExpectedFileOnDisk
		}
		workOptions: WorkOptions.RemoveDelay
	}
	/** Defines a Scan of a Media file Expectation. A Scan is to be performed on (one of) the sources and the scan result is to be stored on the target. */
	export interface MediaFileScan extends Base {
		type: Type.MEDIA_FILE_SCAN

		startRequirement: {
			sources: FileCopy['endRequirement']['targets']
			content: FileCopy['endRequirement']['content']
			version: FileCopy['endRequirement']['version']
		}
		endRequirement: {
			targets: [SpecificPackageContainerOnPackage.CorePackage]
			content: {
				filePath: string
			}
			version: null
		}
		workOptions: WorkOptions.RemoveDelay
	}
	/** Defines a Deep-Scan of a Media file Expectation. A Deep-Scan is to be performed on (one of) the sources and the scan result is to be stored on the target. */
	export interface MediaFileDeepScan extends Base {
		type: Type.MEDIA_FILE_DEEP_SCAN

		startRequirement: {
			sources: FileCopy['endRequirement']['targets']
			content: FileCopy['endRequirement']['content']
			version: FileCopy['endRequirement']['version']
		}
		endRequirement: {
			targets: [SpecificPackageContainerOnPackage.CorePackage]
			content: {
				filePath: string
			}
			version: {
				/** Enable field order detection. An expensive chcek that decodes the start of the video */
				fieldOrder?: boolean
				/** Number of frames to scan to determine files order. Neede sufficient motion, i.e. beyong title card */
				fieldOrderScanDuration?: number

				/** Enable scene change detection */
				scenes?: boolean
				/** Likelihood frame introduces new scene (`0.0` to `1.0`). Defaults to `0.4` */
				sceneThreshold?: number

				/** Enable freeze frame detection */
				freezeDetection?: boolean
				/** Noise tolerance - difference ratio between `0.0` to `1.0`. Default is `0.001` */
				freezeNoise?: number
				/** Duration of freeze before notification. Default is `2s` */
				freezeDuration?: string

				/** Enable black frame detection */
				blackDetection?: boolean
				/** Duration of black until notified. Default `2.0` */
				blackDuration?: string
				/** Ratio of black pixels per frame before frame is black. Value between `0.0` and `1.0` defaulting to `0.98` */
				blackRatio?: number
				/** Luminance threshold for a single pixel to be considered black. Default is `0.1` */
				blackThreshold?: number
			}
		}
		workOptions: WorkOptions.RemoveDelay
	}
	/** Defines a Thumbnail of a Media file Expectation. A Thumbnail is to be created from one of the the sources and the resulting file is to be stored on the target. */
	export interface MediaFileThumbnail extends Base {
		type: Type.MEDIA_FILE_THUMBNAIL

		startRequirement: {
			sources: FileCopy['endRequirement']['targets']
			content: FileCopy['endRequirement']['content']
			version: FileCopy['endRequirement']['version']
		}
		endRequirement: {
			targets: SpecificPackageContainerOnPackage.File[]
			content: {
				filePath: string
			}
			version: Version.ExpectedMediaFileThumbnail
		}
		workOptions: WorkOptions.RemoveDelay
	}
	/** Defines a Preview of a Media file Expectation. A Preview is to be created from one of the the sources and the resulting file is to be stored on the target. */
	export interface MediaFilePreview extends Base {
		type: Type.MEDIA_FILE_PREVIEW

		startRequirement: {
			sources: FileCopy['endRequirement']['targets']
			content: FileCopy['endRequirement']['content']
			version: FileCopy['endRequirement']['version']
		}
		endRequirement: {
			targets: SpecificPackageContainerOnPackage.File[]
			content: {
				filePath: string
			}
			version: Version.ExpectedMediaFilePreview
		}
		workOptions: WorkOptions.RemoveDelay
	}

	/** Defines a Quantel clip Expectation. A Quantel clip is to be copied from one of the Sources, to the Target. */
	export interface QuantelClipCopy extends Base {
		type: Type.QUANTEL_CLIP_COPY

		startRequirement: {
			sources: SpecificPackageContainerOnPackage.QuantelClip[]
		}
		endRequirement: {
			targets: [SpecificPackageContainerOnPackage.QuantelClip]
			content: {
				guid?: string
				title?: string
			}
			version: Expectation.Version.ExpectedQuantelClip
		}
	}

	/** Contains definitions of specific PackageContainer types, used in the Expectation-definitions */
	// eslint-disable-next-line @typescript-eslint/no-namespace
	export namespace SpecificPackageContainerOnPackage {
		/** Defines a PackageContainer for "Files" (ie the stuff stored on a hard drive or equivalent). Contains the various accessors that support files. */
		export interface File extends PackageContainerOnPackage {
			accessors: {
				[accessorId: string]:
					| AccessorOnPackage.LocalFolder
					| AccessorOnPackage.FileShare
					| AccessorOnPackage.HTTP
					| AccessorOnPackage.Quantel
			}
		}
		/** Defines a PackageContainer for CorePackage (A collection in Sofie-Core accessible through an API). */
		export interface CorePackage extends PackageContainerOnPackage {
			accessors: {
				[accessorId: string]: AccessorOnPackage.CorePackageCollection
			}
		}
		/** Defines a PackageContainer for Quantel clips. */
		export interface QuantelClip extends PackageContainerOnPackage {
			accessors: {
				[accessorId: string]: AccessorOnPackage.Quantel
			}
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-namespace
	export namespace WorkOptions {
		export interface RemoveDelay {
			/** When removing, wait a duration of time before actually removing it (milliseconds). If not set, package is removed right away. */
			removeDelay?: number
		}
	}

	/** Version defines properties to use for determining the version of a Package */
	// eslint-disable-next-line @typescript-eslint/no-namespace
	export namespace Version {
		export type ExpectAny =
			| ExpectedFileOnDisk
			| MediaFileThumbnail
			| ExpectedCorePackageInfo
			| ExpectedHTTPFile
			| ExpectedQuantelClip
		export type Any = FileOnDisk | MediaFileThumbnail | CorePackageInfo | HTTPFile | QuantelClip
		export interface Base {
			type: Type
		}
		export enum Type {
			FILE_ON_DISK = 'file_on_disk',
			MEDIA_FILE_THUMBNAIL = 'media_file_thumbnail',
			MEDIA_FILE_PREVIEW = 'media_file_preview',
			CORE_PACKAGE_INFO = 'core_package_info',
			HTTP_FILE = 'http_file',
			QUANTEL_CLIP = 'quantel_clip',
		}
		type ExpectedType<T extends Base> = Partial<T> & Pick<T, 'type'>
		export type ExpectedFileOnDisk = ExpectedType<FileOnDisk>
		export interface FileOnDisk extends Base {
			type: Type.FILE_ON_DISK
			/** File size in bytes */
			fileSize: number
			modifiedDate: number // timestamp (ms)?: number

			// Not implemented (yet?)
			// checksum?: string
			// checkSumType?: 'sha' | 'md5' | 'whatever'
		}
		export type ExpectedMediaFileThumbnail = ExpectedType<MediaFileThumbnail>
		export interface MediaFileThumbnail extends Base {
			type: Type.MEDIA_FILE_THUMBNAIL
			/** Width of the thumbnail */
			width: number
			/** Heigth of the thumbnail, -1=preserve ratio */
			height: number
			/** At what time to pick the thumbnail from [ms] */
			seekTime: number
		}
		export type ExpectedMediaFilePreview = ExpectedType<MediaFilePreview>
		export interface MediaFilePreview extends Base {
			type: Type.MEDIA_FILE_PREVIEW
			bitrate: string // default: '40k'
			width: number
			height: number
		}
		export type ExpectedCorePackageInfo = ExpectedType<CorePackageInfo>
		export interface CorePackageInfo extends Base {
			type: Type.CORE_PACKAGE_INFO
			actualContentVersionHash: string
		}
		export type ExpectedHTTPFile = ExpectedType<HTTPFile>
		export interface HTTPFile extends Base {
			type: Type.HTTP_FILE
			contentType: string
			contentLength: number
			modified: number
			etags: string[]
		}
		export type ExpectedQuantelClip = ExpectedType<QuantelClip>
		export interface QuantelClip extends Base {
			type: Type.QUANTEL_CLIP

			cloneId: number
			created: string

			frames: number // since this can grow during transfer, don't use it for comparing for fullfillment
		}
	}
}
