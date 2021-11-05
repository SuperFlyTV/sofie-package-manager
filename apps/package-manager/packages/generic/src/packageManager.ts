import _ from 'underscore'
import { PeripheralDeviceAPI } from '@sofie-automation/server-core-integration'
import { CoreHandler } from './coreHandler'
import {
	Accessor,
	AccessorOnPackage,
	ExpectedPackage,
	ExpectedPackageStatusAPI,
	PackageContainer,
	PackageContainerOnPackage,
	StatusCode,
} from '@sofie-automation/blueprints-integration'
import { generateExpectations, generatePackageContainerExpectations } from './expectationGenerator'
import {
	ExpectationManager,
	ExpectationManagerCallbacks,
	ExpectationManagerServerOptions,
} from '@shared/expectation-manager'
import {
	ClientConnectionOptions,
	Expectation,
	ExpectationManagerWorkerAgent,
	PackageManagerConfig,
	LoggerInstance,
	PackageContainerExpectation,
	literal,
	Reason,
	deepEqual,
	stringifyError,
} from '@shared/api'
import deepExtend from 'deep-extend'
import clone = require('fast-clone')
import {
	UpdateExpectedPackageWorkStatusesChanges,
	UpdatePackageContainerPackageStatusesChanges,
	UpdatePackageContainerStatusesChanges,
} from './api'

export class PackageManagerHandler {
	public coreHandler!: CoreHandler
	private _observers: Array<any> = []

	public expectationManager: ExpectationManager

	private expectedPackageCache: { [id: string]: ExpectedPackageWrap } = {}
	public packageContainersCache: PackageContainers = {}

	private externalData: { packageContainers: PackageContainers; expectedPackages: ExpectedPackageWrap[] } = {
		packageContainers: {},
		expectedPackages: [],
	}
	private _triggerUpdatedExpectedPackagesTimeout: NodeJS.Timeout | null = null
	public monitoredPackages: {
		[monitorId: string]: ResultingExpectedPackage[]
	} = {}
	settings: PackageManagerSettings = {
		delayRemoval: 0,
		useTemporaryFilePath: false,
	}
	callbacksHandler: ExpectationManagerCallbacksHandler

	private dataSnapshot: {
		updated: number
		expectedPackages: ResultingExpectedPackage[]
		packageContainers: PackageContainers
		expectations: {
			[id: string]: Expectation.Any
		}
		packageContainerExpectations: { [id: string]: PackageContainerExpectation }
	} = {
		updated: 0,
		expectedPackages: [],
		packageContainers: {},
		expectations: {},
		packageContainerExpectations: {},
	}

	constructor(
		public logger: LoggerInstance,
		private managerId: string,
		private serverOptions: ExpectationManagerServerOptions,
		private serverAccessUrl: string | undefined,
		private workForceConnectionOptions: ClientConnectionOptions
	) {
		this.callbacksHandler = new ExpectationManagerCallbacksHandler(this)

		this.expectationManager = new ExpectationManager(
			this.logger,
			this.managerId,
			this.serverOptions,
			this.serverAccessUrl,
			this.workForceConnectionOptions,
			this.callbacksHandler
		)
	}

	async init(_config: PackageManagerConfig, coreHandler: CoreHandler): Promise<void> {
		this.coreHandler = coreHandler

		this.coreHandler.setPackageManagerHandler(this)

		this.logger.info('PackageManagerHandler init')

		// const peripheralDevice = await coreHandler.core.getPeripheralDevice()
		// const settings: TSRSettings = peripheralDevice.settings || {}

		coreHandler.onConnected(() => {
			this.setupObservers()

			// Trigger a send of status updates:
			this.callbacksHandler.onCoreConnected()
		})
		this.setupObservers()
		this.onSettingsChanged()
		this.triggerUpdatedExpectedPackages()

		await this.callbacksHandler.cleanReportedStatuses()
		await this.expectationManager.init()

		this.logger.info('PackageManagerHandler initialized')
	}
	onSettingsChanged(): void {
		this.settings = {
			delayRemoval: this.coreHandler.delayRemoval,
			delayRemovalPackageInfo: this.coreHandler.delayRemovalPackageInfo,
			useTemporaryFilePath: this.coreHandler.useTemporaryFilePath,
		}
		this.triggerUpdatedExpectedPackages()
	}
	getExpectationManager(): ExpectationManager {
		return this.expectationManager
	}

	setExternalData(packageContainers: PackageContainers, expectedPackages: ExpectedPackage.Any[]): void {
		const expectedPackagesWraps: ExpectedPackageWrap[] = []

		for (const expectedPackage of expectedPackages) {
			const wrap = wrapExpectedPackage(packageContainers, expectedPackage)
			if (wrap) {
				expectedPackagesWraps.push(wrap)
			}
		}

		this.externalData = {
			packageContainers: packageContainers,
			expectedPackages: expectedPackagesWraps,
		}
		this.triggerUpdatedExpectedPackages()
	}
	private setupObservers(): void {
		if (this._observers.length) {
			this.logger.debug('Clearing observers..')
			this._observers.forEach((obs) => {
				obs.stop()
			})
			this._observers = []
		}
		this.logger.debug('Renewing observers')

		const expectedPackagesObserver = this.coreHandler.core.observe('deviceExpectedPackages')
		expectedPackagesObserver.added = () => {
			this.triggerUpdatedExpectedPackages()
		}
		expectedPackagesObserver.changed = () => {
			this.triggerUpdatedExpectedPackages()
		}
		expectedPackagesObserver.removed = () => {
			this.triggerUpdatedExpectedPackages()
		}
		this._observers.push(expectedPackagesObserver)
	}
	public triggerUpdatedExpectedPackages(): void {
		if (this._triggerUpdatedExpectedPackagesTimeout) {
			clearTimeout(this._triggerUpdatedExpectedPackagesTimeout)
			this._triggerUpdatedExpectedPackagesTimeout = null
		}

		this._triggerUpdatedExpectedPackagesTimeout = setTimeout(() => {
			this._triggerUpdatedExpectedPackagesTimeout = null

			const expectedPackages: ExpectedPackageWrap[] = []
			const packageContainers: PackageContainers = {}

			const objs = this.coreHandler.core.getCollection('deviceExpectedPackages').find(() => true)

			const activePlaylistObj = objs.find((o) => o.type === 'active_playlist')
			if (!activePlaylistObj) {
				this.logger.warn(`Collection objects active_playlist not found`)
				this.logger.info(`objs in deviceExpectedPackages:`, objs)
				return
			}
			const activePlaylist = activePlaylistObj.activeplaylist as ActivePlaylist
			const activeRundowns = activePlaylistObj.activeRundowns as ActiveRundown[]

			// Add from external data:
			{
				for (const expectedPackage of this.externalData.expectedPackages) {
					expectedPackages.push(expectedPackage)
				}
				Object.assign(packageContainers, this.externalData.packageContainers)
			}

			// Add from Core collections:
			{
				const expectedPackageObjs = objs.filter((o) => o.type === 'expected_packages')

				if (!expectedPackageObjs.length) {
					this.logger.warn(`Collection objects expected_packages not found`)
					this.logger.info(`objs in deviceExpectedPackages:`, objs)
					return
				}
				for (const expectedPackageObj of expectedPackageObjs) {
					for (const expectedPackage of expectedPackageObj.expectedPackages) {
						// Note: There might be duplicates of packages here, to be deduplicated later
						expectedPackages.push(expectedPackage)
					}
				}

				const packageContainerObj = objs.find((o) => o.type === 'package_containers')
				if (!packageContainerObj) {
					this.logger.warn(`Collection objects package_containers not found`)
					this.logger.info(`objs in deviceExpectedPackages:`, objs)
					return
				}
				Object.assign(packageContainers, packageContainerObj.packageContainers as PackageContainers)
			}

			// Add from Monitors:
			{
				for (const monitorExpectedPackages of Object.values(this.monitoredPackages)) {
					for (const expectedPackage of monitorExpectedPackages) {
						expectedPackages.push(expectedPackage)
					}
				}
			}

			this.handleExpectedPackages(packageContainers, activePlaylist, activeRundowns, expectedPackages)
		}, 300)
	}

	private handleExpectedPackages(
		packageContainers: PackageContainers,
		activePlaylist: ActivePlaylist,
		activeRundowns: ActiveRundown[],

		expectedPackages: ExpectedPackageWrap[]
	) {
		// Step 0: Save local cache:
		this.expectedPackageCache = {}
		this.packageContainersCache = packageContainers
		for (const exp of expectedPackages) {
			// Note: There might be duplicates in expectedPackages

			const existing = this.expectedPackageCache[exp.expectedPackage._id]
			if (
				!existing ||
				existing.priority > exp.priority // If the existing priority is lower (ie higher), replace it
			) {
				this.expectedPackageCache[exp.expectedPackage._id] = exp
			}
		}

		this.logger.debug(`Has ${expectedPackages.length} expectedPackages`)
		// this.logger.debug(JSON.stringify(expectedPackages, null, 2))

		this.dataSnapshot.expectedPackages = expectedPackages
		this.dataSnapshot.packageContainers = this.packageContainersCache

		// Step 1: Generate expectations:
		const expectations = generateExpectations(
			this.logger,
			this.expectationManager.managerId,
			this.packageContainersCache,
			activePlaylist,
			activeRundowns,
			expectedPackages,
			this.settings
		)
		this.logger.debug(`Has ${Object.keys(expectations).length} expectations`)
		// console.log(JSON.stringify(expectations, null, 2))
		this.dataSnapshot.expectations = expectations

		const packageContainerExpectations = generatePackageContainerExpectations(
			this.expectationManager.managerId,
			this.packageContainersCache,
			activePlaylist
		)
		this.logger.debug(`Has ${Object.keys(packageContainerExpectations).length} packageContainerExpectations`)
		this.dataSnapshot.packageContainerExpectations = packageContainerExpectations
		this.dataSnapshot.updated = Date.now()

		this.ensureMandatoryPackageContainerExpectations(packageContainerExpectations)

		// Step 2: Track and handle new expectations:
		this.expectationManager.updatePackageContainerExpectations(packageContainerExpectations)

		this.expectationManager.updateExpectations(expectations)
	}
	public restartExpectation(workId: string): void {
		// This method can be called from core
		this.expectationManager.restartExpectation(workId)
	}
	public restartAllExpectations(): void {
		// This method can be called from core
		this.expectationManager.restartAllExpectations()
	}
	public abortExpectation(workId: string): void {
		// This method can be called from core
		this.expectationManager.abortExpectation(workId)
	}
	public restartPackageContainer(containerId: string): void {
		// This method can be called from core
		this.expectationManager.restartPackageContainer(containerId)
	}
	public getDataSnapshot(): any {
		return {
			...this.dataSnapshot,

			reportedStatuses: {
				reportedWorkStatuses: this.callbacksHandler.reportedWorkStatuses,
				reportedPackageStatuses: this.callbacksHandler.reportedPackageStatuses,
				reportedPackageContainerStatuses: this.callbacksHandler.reportedPackageContainerStatuses,
			},
		}
	}
	public async getExpetationManagerStatus(): Promise<any> {
		return {
			...(await this.expectationManager.getStatus()),
			packageManager: {
				workforceURL:
					this.workForceConnectionOptions.type === 'websocket' ? this.workForceConnectionOptions.url : null,
				lastUpdated: this.dataSnapshot.updated,
				countExpectedPackages: this.dataSnapshot.expectedPackages.length,
				countPackageContainers: Object.keys(this.dataSnapshot.packageContainers).length,
				countExpectations: Object.keys(this.dataSnapshot.expectations).length,
				countPackageContainerExpectations: Object.keys(this.dataSnapshot.packageContainerExpectations).length,
			},
		}
	}
	public async debugKillApp(appId: string): Promise<void> {
		return this.expectationManager.debugKillApp(appId)
	}

	/** Ensures that the packageContainerExpectations containes the mandatory expectations */
	private ensureMandatoryPackageContainerExpectations(packageContainerExpectations: {
		[id: string]: PackageContainerExpectation
	}): void {
		for (const [containerId, packageContainer] of Object.entries(this.packageContainersCache)) {
			/** Is the Container writeable */
			let isWriteable = false
			for (const accessor of Object.values(packageContainer.accessors)) {
				if (accessor.allowWrite) {
					isWriteable = true
					break
				}
			}
			if (!packageContainerExpectations[containerId]) {
				// Add default packageContainerExpectation:
				// All packageContainers should get a default expectation, so that statuses are reported back.
				packageContainerExpectations[containerId] = literal<PackageContainerExpectation>({
					...packageContainer,
					id: containerId,
					managerId: this.expectationManager.managerId,
					cronjobs: {
						// interval: 0,
					},
					monitors: {},
				})
			}
			if (isWriteable) {
				// All writeable packageContainers should have the clean-up cronjob:
				packageContainerExpectations[containerId].cronjobs.cleanup = {
					label: 'Clean up old packages',
				} // Add cronjob to clean up
			}
		}
	}
}
export function omit<T, P extends keyof T>(obj: T, ...props: P[]): Omit<T, P> {
	return _.omit(obj, ...(props as string[])) as any
}

/** This class handles data and requests that comes from ExpectationManager. */
class ExpectationManagerCallbacksHandler implements ExpectationManagerCallbacks {
	private logger: LoggerInstance

	private triggerSendUpdatedStatusesTimeout: NodeJS.Timeout | undefined

	private toReportExpectationStatus: {
		[id: string]: {
			workStatus: ExpectedPackageStatusAPI.WorkStatus | null
			/** If the status is new and needs to be reported to Core */
			isUpdated: boolean
		}
	} = {}
	public reportedWorkStatuses: { [id: string]: ExpectedPackageStatusAPI.WorkStatus } = {}

	private toReportPackageStatus: {
		[key: string]: {
			containerId: string
			packageId: string
			packageStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus | null
			/** If the status is new and needs to be reported to Core */
			isUpdated: boolean
		}
	} = {}
	public reportedPackageStatuses: { [id: string]: ExpectedPackageStatusAPI.PackageContainerPackageStatus } = {}

	private toReportPackageContainerStatus: {
		[containerId: string]: {
			status: ExpectedPackageStatusAPI.PackageContainerStatus | null
			/** If the status is new and needs to be reported to Core */
			isUpdated: boolean
		}
	} = {}
	public reportedPackageContainerStatuses: { [id: string]: ExpectedPackageStatusAPI.PackageContainerStatus } = {}

	constructor(private packageManager: PackageManagerHandler) {
		this.logger = this.packageManager.logger
	}

	public reportExpectationStatus(
		expectationId: string,
		expectaction: Expectation.Any | null,
		actualVersionHash: string | null,
		statusInfo: {
			status?: ExpectedPackageStatusAPI.WorkStatusState
			progress?: number
			priority?: number
			statusReason?: Reason
			prevStatusReasons?: { [state: string]: Reason }
		}
	): void {
		if (!expectaction) {
			if (this.toReportExpectationStatus[expectationId]) {
				this.updateExpectationStatus(expectationId, null)
			}
		} else {
			if (!expectaction.statusReport.sendReport) return // Don't report the status

			const previouslyReported = this.toReportExpectationStatus[expectationId]?.workStatus

			// Remove undefined properties, so they don't mess with the spread operators below:
			deleteAllUndefinedProperties(expectaction.statusReport)
			deleteAllUndefinedProperties(statusInfo)

			const workStatus: ExpectedPackageStatusAPI.WorkStatus = {
				// Default properties:
				...{
					status: ExpectedPackageStatusAPI.WorkStatusState.NEW,
					statusChanged: 0,
					progress: 0,
					priority: 9999,
					statusReason: { user: '', tech: '' },
					prevStatusReasons: {},
				},
				// Previous properties:
				...((previouslyReported || {}) as Partial<ExpectedPackageStatusAPI.WorkStatus>), // Intentionally cast to Partial<>, to make typings in const workStatus more strict

				// Updated properties:
				...expectaction.statusReport,
				...statusInfo,

				fromPackages: expectaction.fromPackages.map((fromPackage) => {
					const prevPromPackage = this.toReportExpectationStatus[
						expectationId
					]?.workStatus?.fromPackages.find((p) => p.id === fromPackage.id)
					return {
						id: fromPackage.id,
						expectedContentVersionHash: fromPackage.expectedContentVersionHash,
						actualContentVersionHash: actualVersionHash || prevPromPackage?.actualContentVersionHash || '',
					}
				}),
			}

			// Update statusChanged:
			workStatus.statusChanged = previouslyReported?.statusChanged || Date.now()
			if (
				workStatus.status !== previouslyReported?.status ||
				workStatus.progress !== previouslyReported?.progress
				// (not checking statusReason, as that should not affect statusChanged)
			) {
				workStatus.statusChanged = Date.now()
			}

			this.updateExpectationStatus(expectationId, workStatus)
		}
	}
	public reportPackageContainerPackageStatus(
		containerId: string,
		packageId: string,
		packageStatus: Omit<ExpectedPackageStatusAPI.PackageContainerPackageStatus, 'statusChanged'> | null
	): void {
		const packageContainerPackageId = `${containerId}_${packageId}`
		if (!packageStatus) {
			this.updatePackageContainerPackageStatus(containerId, packageId, null)
		} else {
			const previouslyReported = this.toReportPackageStatus[packageContainerPackageId]?.packageStatus

			const containerStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus = {
				// Default properties:
				...{
					status: ExpectedPackageStatusAPI.PackageContainerPackageStatusStatus.NOT_READY,
					progress: 0,
					statusChanged: 0,
					statusReason: { user: '', tech: '' },
				},
				// pre-existing properties:
				...((previouslyReported || {}) as Partial<ExpectedPackageStatusAPI.PackageContainerPackageStatus>), // Intentionally cast to Partial<>, to make typings in const containerStatus more strict
				// Updated properties:
				...packageStatus,
			}

			// Update statusChanged:
			containerStatus.statusChanged = previouslyReported?.statusChanged || Date.now()
			if (
				containerStatus.status !== previouslyReported?.status ||
				containerStatus.progress !== previouslyReported?.progress
				// (not checking statusReason, as that should not affect statusChanged)
			) {
				containerStatus.statusChanged = Date.now()
			}

			this.updatePackageContainerPackageStatus(containerId, packageId, containerStatus)
		}
	}
	public reportPackageContainerExpectationStatus(
		containerId: string,
		statusInfo: ExpectedPackageStatusAPI.PackageContainerStatus | null
	): void {
		if (!statusInfo) {
			this.updatePackageContainerStatus(containerId, null)
		} else {
			const previouslyReported = this.toReportPackageContainerStatus[containerId]?.status

			const containerStatus: ExpectedPackageStatusAPI.PackageContainerStatus = {
				// Default properties:
				...{
					status: StatusCode.UNKNOWN,
					statusReason: {
						user: '',
						tech: '',
					},
					statusChanged: 0,

					monitors: {},
				},
				// pre-existing properties:
				...((previouslyReported || {}) as Partial<ExpectedPackageStatusAPI.PackageContainerStatus>), // Intentionally cast to Partial<>, to make typings in const containerStatus more strict
				// Updated properties:
				...statusInfo,
			}

			// Update statusChanged:
			containerStatus.statusChanged = previouslyReported?.statusChanged || Date.now()
			if (!deepEqual(containerStatus, previouslyReported)) {
				containerStatus.statusChanged = Date.now()
				this.updatePackageContainerStatus(containerId, containerStatus)
			}
		}
	}
	public async messageFromWorker(message: ExpectationManagerWorkerAgent.MessageFromWorkerPayload.Any): Promise<any> {
		switch (message.type) {
			case 'fetchPackageInfoMetadata':
				return this.packageManager.coreHandler.core.callMethod(
					PeripheralDeviceAPI.methods.fetchPackageInfoMetadata,
					message.arguments
				)
			case 'updatePackageInfo':
				return this.packageManager.coreHandler.core.callMethod(
					PeripheralDeviceAPI.methods.updatePackageInfo,
					message.arguments
				)
			case 'removePackageInfo':
				return this.packageManager.coreHandler.core.callMethod(
					PeripheralDeviceAPI.methods.removePackageInfo,
					message.arguments
				)
			case 'reportFromMonitorPackages':
				this.reportMonitoredPackages(...message.arguments)
				break

			default:
				// @ts-expect-error message is never
				throw new Error(`Unsupported message type "${message.type}"`)
		}
	}
	public async cleanReportedStatuses() {
		// Clean out all reported statuses, this is an easy way to sync a clean state with core
		this.reportedWorkStatuses = {}
		await this.packageManager.coreHandler.core.callMethod(
			PeripheralDeviceAPI.methods.removeAllExpectedPackageWorkStatusOfDevice,
			[]
		)
		await this.packageManager.coreHandler.core.callMethod(
			PeripheralDeviceAPI.methods.removeAllPackageContainerPackageStatusesOfDevice,
			[]
		)
		await this.packageManager.coreHandler.core.callMethod(
			PeripheralDeviceAPI.methods.removeAllPackageContainerStatusesOfDevice,
			[]
		)
	}
	public onCoreConnected() {
		this.triggerReportUpdatedStatuses()
	}
	private updateExpectationStatus(expectationId: string, workStatus: ExpectedPackageStatusAPI.WorkStatus | null) {
		this.toReportExpectationStatus[expectationId] = {
			workStatus: workStatus,
			isUpdated: true,
		}
		this.triggerReportUpdatedStatuses()
	}
	private updatePackageContainerPackageStatus(
		containerId: string,
		packageId: string,
		packageStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus | null
	): void {
		const key = `${containerId}_${packageId}`
		this.toReportPackageStatus[key] = {
			containerId,
			packageId,
			packageStatus,
			isUpdated: true,
		}
		this.triggerReportUpdatedStatuses()
	}
	private updatePackageContainerStatus(
		containerId: string,
		containerStatus: ExpectedPackageStatusAPI.PackageContainerStatus | null
	) {
		this.toReportPackageContainerStatus[containerId] = {
			status: containerStatus,
			isUpdated: true,
		}
		this.triggerReportUpdatedStatuses()
	}
	private triggerReportUpdatedStatuses() {
		const WAIT_TIME = 300

		if (!this.triggerSendUpdatedStatusesTimeout) {
			this.triggerSendUpdatedStatusesTimeout = setTimeout(() => {
				try {
					// Don't send any statuses if not connected:
					if (!this.packageManager.coreHandler.core.connected) return

					this.reportUpdateExpectationStatus()
					this.reportUpdatePackageContainerPackageStatus()
					this.reportUpdatePackageContainerStatus()
				} catch (err) {
					this.logger.error('Error in triggerSendUpdatedStatuses', err)
				}
				delete this.triggerSendUpdatedStatusesTimeout
			}, WAIT_TIME)
		}
	}
	private reportUpdateExpectationStatus() {
		const changesTosend: UpdateExpectedPackageWorkStatusesChanges = []

		for (const [expectationId, o] of Object.entries(this.toReportExpectationStatus)) {
			if (o.isUpdated) {
				if (!o.workStatus) {
					if (this.reportedWorkStatuses[expectationId]) {
						// Removed
						changesTosend.push({
							id: expectationId,
							type: 'delete',
						})
						delete this.reportedWorkStatuses[expectationId]
					}
				} else {
					const lastReportedStatus = this.reportedWorkStatuses[expectationId]

					if (!lastReportedStatus) {
						// Inserted
						changesTosend.push({
							id: expectationId,
							type: 'insert',
							status: o.workStatus,
						})
					} else {
						// Updated
						const mod: Partial<ExpectedPackageStatusAPI.WorkStatus> = {}
						for (const key of Object.keys(o.workStatus) as (keyof ExpectedPackageStatusAPI.WorkStatus)[]) {
							if (o.workStatus[key] !== lastReportedStatus[key]) {
								mod[key] = o.workStatus[key] as any
							}
						}
						if (!_.isEmpty(mod)) {
							changesTosend.push({
								id: expectationId,
								type: 'update',
								status: mod,
							})
						}
					}
					this.reportedWorkStatuses[expectationId] = o.workStatus
				}

				o.isUpdated = false
			}
		}

		if (changesTosend.length) {
			this.packageManager.coreHandler.core
				.callMethod(PeripheralDeviceAPI.methods.updateExpectedPackageWorkStatuses, [changesTosend])
				.catch((err) => {
					this.logger.error('Error when calling method updateExpectedPackageWorkStatuses:')
					this.logger.error(err)
				})
		}
	}
	private reportUpdatePackageContainerPackageStatus(): void {
		const changesTosend: UpdatePackageContainerPackageStatusesChanges = []

		for (const [key, o] of Object.entries(this.toReportPackageStatus)) {
			if (o.isUpdated) {
				if (!o.packageStatus) {
					if (this.reportedPackageStatuses[key]) {
						// Removed
						changesTosend.push({
							containerId: o.containerId,
							packageId: o.packageId,
							type: 'delete',
						})
						delete this.reportedPackageStatuses[key]
					}
				} else {
					// Inserted / Updated
					changesTosend.push({
						containerId: o.containerId,
						packageId: o.packageId,
						type: 'update',
						status: o.packageStatus,
					})
					this.reportedPackageStatuses[key] = o.packageStatus
				}

				o.isUpdated = false
			}
		}

		if (changesTosend.length) {
			this.packageManager.coreHandler.core
				.callMethod(PeripheralDeviceAPI.methods.updatePackageContainerPackageStatuses, [changesTosend])
				.catch((err) => {
					this.logger.error('Error when calling method updatePackageContainerPackageStatuses:')
					this.logger.error(err)
				})
		}
	}
	private reportUpdatePackageContainerStatus(): void {
		const changesTosend: UpdatePackageContainerStatusesChanges = []

		for (const [containerId, o] of Object.entries(this.toReportPackageContainerStatus)) {
			if (o.isUpdated) {
				if (!o.status) {
					if (this.reportedPackageContainerStatuses[containerId]) {
						// Removed
						changesTosend.push({
							containerId: containerId,
							type: 'delete',
						})
						delete this.reportedPackageContainerStatuses[containerId]
					}
				} else {
					// Inserted / Updated
					changesTosend.push({
						containerId: containerId,
						type: 'update',
						status: o.status,
					})
					this.reportedPackageContainerStatuses[containerId] = o.status
				}

				o.isUpdated = false
			}
		}

		if (changesTosend.length) {
			this.packageManager.coreHandler.core
				.callMethod(PeripheralDeviceAPI.methods.updatePackageContainerStatuses, [changesTosend])
				.catch((err) => {
					this.logger.error('Error when calling method updatePackageContainerStatuses:')
					this.logger.error(err)
				})
		}
	}
	private reportMonitoredPackages(_containerId: string, monitorId: string, expectedPackages: ExpectedPackage.Any[]) {
		const expectedPackagesWraps: ExpectedPackageWrap[] = []

		for (const expectedPackage of expectedPackages) {
			const wrap = wrapExpectedPackage(this.packageManager.packageContainersCache, expectedPackage)
			if (wrap) {
				expectedPackagesWraps.push(wrap)
			}
		}

		this.logger.debug(
			`reportMonitoredPackages: ${expectedPackages.length} packages, ${expectedPackagesWraps.length} wraps`
		)

		this.packageManager.monitoredPackages[monitorId] = expectedPackagesWraps

		this.packageManager.triggerUpdatedExpectedPackages()
	}
}
function wrapExpectedPackage(
	packageContainers: PackageContainers,
	expectedPackage: ExpectedPackage.Any
): ExpectedPackageWrap | undefined {
	const combinedSources: PackageContainerOnPackage[] = []
	for (const packageSource of expectedPackage.sources) {
		const lookedUpSource: PackageContainer = packageContainers[packageSource.containerId]
		if (lookedUpSource) {
			// We're going to combine the accessor attributes set on the Package with the ones defined on the source:
			const combinedSource: PackageContainerOnPackage = {
				...omit(clone(lookedUpSource), 'accessors'),
				accessors: {},
				containerId: packageSource.containerId,
			}

			const accessorIds = _.uniq(
				Object.keys(lookedUpSource.accessors).concat(Object.keys(packageSource.accessors || {}))
			)

			for (const accessorId of accessorIds) {
				const sourceAccessor = lookedUpSource.accessors[accessorId] as Accessor.Any | undefined

				const packageAccessor = packageSource.accessors[accessorId] as AccessorOnPackage.Any | undefined

				if (packageAccessor && sourceAccessor && packageAccessor.type === sourceAccessor.type) {
					combinedSource.accessors[accessorId] = deepExtend({}, sourceAccessor, packageAccessor)
				} else if (packageAccessor) {
					combinedSource.accessors[accessorId] = clone<AccessorOnPackage.Any>(packageAccessor)
				} else if (sourceAccessor) {
					combinedSource.accessors[accessorId] = clone<Accessor.Any>(sourceAccessor) as AccessorOnPackage.Any
				}
			}
			combinedSources.push(combinedSource)
		}
	}
	// Lookup Package targets:
	const combinedTargets: PackageContainerOnPackage[] = []

	for (const layer of expectedPackage.layers) {
		// Hack: we use the layer name as a 1-to-1 relation to a target containerId
		const packageContainerId: string = layer

		if (packageContainerId) {
			const lookedUpTarget = packageContainers[packageContainerId]
			if (lookedUpTarget) {
				combinedTargets.push({
					...omit(clone(lookedUpTarget), 'accessors'),
					accessors: lookedUpTarget.accessors as {
						[accessorId: string]: AccessorOnPackage.Any
					},
					containerId: packageContainerId,
				})
			}
		}
	}

	if (combinedSources.length) {
		if (combinedTargets.length) {
			return {
				expectedPackage: expectedPackage,
				priority: 999, // Default: lowest priority
				sources: combinedSources,
				targets: combinedTargets,
				playoutDeviceId: '',
				external: true,
			}
		}
	}
	return undefined
}
/**
 * Recursively delete all undefined properties from the supplied object.
 * This is necessary as _.isEqual({ a: 1 }, { a: 1, b: undefined }) === false
 */
export function deleteAllUndefinedProperties<T extends { [key: string]: any }>(obj: T): void {
	if (Array.isArray(obj)) {
		for (const v of obj) {
			deleteAllUndefinedProperties(v)
		}
	} else if (obj && typeof obj === 'object') {
		const keys = Object.keys(obj)
		for (const key of keys) {
			if (obj[key] === undefined) {
				delete obj[key]
			} else {
				deleteAllUndefinedProperties(obj[key])
			}
		}
	}
}

interface ResultingExpectedPackage {
	// This interface is copied from Core

	expectedPackage: ExpectedPackage.Base & { rundownId?: string }
	/** Lower should be done first */
	priority: number
	sources: PackageContainerOnPackage[]
	targets: PackageContainerOnPackage[]
	playoutDeviceId: string
	/** If set to true, this doesn't come from Core */
	external?: boolean
	// playoutLocation: any // todo?
}
export type ExpectedPackageWrap = ResultingExpectedPackage

export type PackageContainers = { [containerId: string]: PackageContainer }

export interface ActivePlaylist {
	_id: string
	active: boolean
	rehearsal: boolean
}
export interface ActiveRundown {
	_id: string
	_rank: number
}
export interface PackageManagerSettings {
	delayRemoval: number
	delayRemovalPackageInfo?: number
	useTemporaryFilePath: boolean
}
