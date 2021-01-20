import { Accessor, AccessorOnPackage } from '@sofie-automation/blueprints-integration'
import { GenericWorker } from '../worker'
import { CorePackageInfoAccessorHandle } from './corePackageInfo'
import { GenericAccessorHandle as GenericAccessorHandle } from './genericHandle'
import { LocalFolderAccessorHandle } from './localFolder'

export function getAccessorHandle<Metadata>(
	worker: GenericWorker,
	accessor: AccessorOnPackage.Any,
	content: unknown
): GenericAccessorHandle<Metadata> {
	if (accessor.type === Accessor.AccessType.LOCAL_FOLDER) {
		return new LocalFolderAccessorHandle(worker, accessor, content as any)
	} else if (accessor.type === Accessor.AccessType.CORE_PACKAGE_INFO) {
		return new CorePackageInfoAccessorHandle(worker, accessor, content as any)
	} else {
		throw new Error(`Unsupported Accessor type "${accessor.type}"`)
	}
}

export function isLocalFolderHandle<Metadata>(
	accessorHandler: GenericAccessorHandle<Metadata>
): accessorHandler is LocalFolderAccessorHandle<Metadata> {
	return accessorHandler.type === 'localFolder'
}
export function isCorePackageInfoAccessorHandle<Metadata>(
	accessorHandler: GenericAccessorHandle<Metadata>
): accessorHandler is CorePackageInfoAccessorHandle<Metadata> {
	return accessorHandler.type === 'corePackageInfo'
}