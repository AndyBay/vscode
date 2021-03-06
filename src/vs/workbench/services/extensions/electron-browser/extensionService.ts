/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import * as errors from 'vs/base/common/errors';
import * as objects from 'vs/base/common/objects';
import Severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';
import pkg from 'vs/platform/node/package';
import * as path from 'path';
import * as pfs from 'vs/base/node/pfs';
import URI from 'vs/base/common/uri';
import * as platform from 'vs/base/common/platform';
import { ExtensionDescriptionRegistry } from 'vs/workbench/services/extensions/node/extensionDescriptionRegistry';
import { IMessage, IExtensionDescription, IExtensionsStatus, IExtensionService, ExtensionPointContribution, ActivationTimes, IExtensionHostInformation, ProfileSession, USER_MANIFEST_CACHE_FILE, BUILTIN_MANIFEST_CACHE_FILE, MANIFEST_CACHE_FOLDER } from 'vs/platform/extensions/common/extensions';
import { IExtensionEnablementService, IExtensionIdentifier, EnablementState } from 'vs/platform/extensionManagement/common/extensionManagement';
import { areSameExtensions, BetterMergeId, BetterMergeDisabledNowKey } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { ExtensionsRegistry, ExtensionPoint, IExtensionPointUser, ExtensionMessageCollector, IExtensionPoint } from 'vs/platform/extensions/common/extensionsRegistry';
import { ExtensionScanner, ILog, ExtensionScannerInput } from 'vs/workbench/services/extensions/electron-browser/extensionPoints';
import { IMessageService, CloseAction } from 'vs/platform/message/common/message';
import { ProxyIdentifier } from 'vs/workbench/services/thread/common/threadService';
import { ExtHostContext, ExtHostExtensionServiceShape, IExtHostContext, MainContext } from 'vs/workbench/api/node/extHost.protocol';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ExtensionHostProcessWorker } from 'vs/workbench/services/extensions/electron-browser/extensionHost';
import { MainThreadService } from 'vs/workbench/services/thread/electron-browser/threadService';
import { IMessagePassingProtocol } from 'vs/base/parts/ipc/common/ipc';
import { ExtHostCustomersRegistry } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { Action } from 'vs/base/common/actions';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { mark, time } from 'vs/base/common/performance';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { Barrier } from 'vs/base/common/async';
import Event, { Emitter } from 'vs/base/common/event';
import { ExtensionHostProfiler } from 'vs/workbench/services/extensions/electron-browser/extensionHostProfiler';
import { ReloadWindowAction } from 'vs/workbench/electron-browser/actions';

const SystemExtensionsRoot = path.normalize(path.join(URI.parse(require.toUrl('')).fsPath, '..', 'extensions'));

function messageWithSource(msg: IMessage): string {
	return messageWithSource2(msg.source, msg.message);
}

function messageWithSource2(source: string, message: string): string {
	if (source) {
		return `[${source}]: ${message}`;
	}
	return message;
}

const hasOwnProperty = Object.hasOwnProperty;
const NO_OP_VOID_PROMISE = TPromise.wrap<void>(void 0);

export class ExtensionService extends Disposable implements IExtensionService {
	public _serviceBrand: any;

	private _onDidRegisterExtensions: Emitter<IExtensionDescription[]>;

	private _registry: ExtensionDescriptionRegistry;
	private readonly _installedExtensionsReady: Barrier;
	private readonly _isDev: boolean;
	private readonly _extensionsMessages: { [id: string]: IMessage[] };
	private _allRequestedActivateEvents: { [activationEvent: string]: boolean; };

	private readonly _onDidChangeExtensionsStatus: Emitter<string[]> = this._register(new Emitter<string[]>());
	public readonly onDidChangeExtensionsStatus: Event<string[]> = this._onDidChangeExtensionsStatus.event;

	// --- Members used per extension host process

	/**
	 * A map of already activated events to speed things up if the same activation event is triggered multiple times.
	 */
	private _extensionHostProcessFinishedActivateEvents: { [activationEvent: string]: boolean; };
	private _extensionHostProcessActivationTimes: { [id: string]: ActivationTimes; };
	private _extensionHostExtensionRuntimeErrors: { [id: string]: Error[]; };
	private _extensionHostProcessWorker: ExtensionHostProcessWorker;
	private _extensionHostProcessThreadService: MainThreadService;
	private _extensionHostProcessCustomers: IDisposable[];
	/**
	 * winjs believes a proxy is a promise because it has a `then` method, so wrap the result in an object.
	 */
	private _extensionHostProcessProxy: TPromise<{ value: ExtHostExtensionServiceShape; }>;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IMessageService private readonly _messageService: IMessageService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IExtensionEnablementService private readonly _extensionEnablementService: IExtensionEnablementService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWindowService private readonly _windowService: IWindowService,
		@ILifecycleService lifecycleService: ILifecycleService
	) {
		super();
		this._registry = null;
		this._installedExtensionsReady = new Barrier();
		this._isDev = !this._environmentService.isBuilt || this._environmentService.isExtensionDevelopment;
		this._extensionsMessages = {};
		this._allRequestedActivateEvents = Object.create(null);

		this._onDidRegisterExtensions = new Emitter<IExtensionDescription[]>();

		this._extensionHostProcessFinishedActivateEvents = Object.create(null);
		this._extensionHostProcessActivationTimes = Object.create(null);
		this._extensionHostExtensionRuntimeErrors = Object.create(null);
		this._extensionHostProcessWorker = null;
		this._extensionHostProcessThreadService = null;
		this._extensionHostProcessCustomers = [];
		this._extensionHostProcessProxy = null;

		lifecycleService.when(LifecyclePhase.Running).then(() => {
			// delay extension host creation and extension scanning
			// until after workbench is running
			this._startExtensionHostProcess([]);
			this._scanAndHandleExtensions();
		});
	}

	public dispose(): void {
		super.dispose();
	}

	public get onDidRegisterExtensions(): Event<IExtensionDescription[]> {
		return this._onDidRegisterExtensions.event;
	}

	public getExtensionHostInformation(): IExtensionHostInformation {
		if (!this._extensionHostProcessWorker) {
			throw errors.illegalState();
		}
		return <IExtensionHostInformation>{
			inspectPort: this._extensionHostProcessWorker.getInspectPort()
		};
	}

	public restartExtensionHost(): void {
		this._stopExtensionHostProcess();
		this._startExtensionHostProcess(Object.keys(this._allRequestedActivateEvents));
	}

	public startExtensionHost(): void {
		this._startExtensionHostProcess(Object.keys(this._allRequestedActivateEvents));
	}

	public stopExtensionHost(): void {
		this._stopExtensionHostProcess();
	}

	private _stopExtensionHostProcess(): void {
		const previouslyActivatedExtensionIds = Object.keys(this._extensionHostProcessActivationTimes);

		this._extensionHostProcessFinishedActivateEvents = Object.create(null);
		this._extensionHostProcessActivationTimes = Object.create(null);
		this._extensionHostExtensionRuntimeErrors = Object.create(null);
		if (this._extensionHostProcessWorker) {
			this._extensionHostProcessWorker.dispose();
			this._extensionHostProcessWorker = null;
		}
		if (this._extensionHostProcessThreadService) {
			this._extensionHostProcessThreadService.dispose();
			this._extensionHostProcessThreadService = null;
		}
		for (let i = 0, len = this._extensionHostProcessCustomers.length; i < len; i++) {
			const customer = this._extensionHostProcessCustomers[i];
			try {
				customer.dispose();
			} catch (err) {
				errors.onUnexpectedError(err);
			}
		}
		this._extensionHostProcessCustomers = [];
		this._extensionHostProcessProxy = null;

		this._onDidChangeExtensionsStatus.fire(previouslyActivatedExtensionIds);
	}

	private _startExtensionHostProcess(initialActivationEvents: string[]): void {
		this._stopExtensionHostProcess();

		this._extensionHostProcessWorker = this._instantiationService.createInstance(ExtensionHostProcessWorker, this);
		this._extensionHostProcessWorker.onCrashed(([code, signal]) => this._onExtensionHostCrashed(code, signal));
		this._extensionHostProcessProxy = this._extensionHostProcessWorker.start().then(
			(protocol) => {
				return { value: this._createExtensionHostCustomers(protocol) };
			},
			(err) => {
				console.error('Error received from starting extension host');
				console.error(err);
				return null;
			}
		);
		this._extensionHostProcessProxy.then(() => {
			initialActivationEvents.forEach((activationEvent) => this.activateByEvent(activationEvent));
		});
	}

	private _onExtensionHostCrashed(code: number, signal: string): void {
		const openDevTools = new Action('openDevTools', nls.localize('devTools', "Developer Tools"), '', true, (): TPromise<boolean> => {
			return this._windowService.openDevTools().then(() => false);
		});

		const restart = new Action('restart', nls.localize('restart', "Restart Extension Host"), '', true, (): TPromise<boolean> => {
			this._messageService.hideAll();
			this._startExtensionHostProcess(Object.keys(this._allRequestedActivateEvents));
			return TPromise.as(true);
		});

		console.error('Extension host terminated unexpectedly. Code: ', code, ' Signal: ', signal);
		this._stopExtensionHostProcess();

		let message = nls.localize('extensionHostProcess.crash', "Extension host terminated unexpectedly.");
		if (code === 87) {
			message = nls.localize('extensionHostProcess.unresponsiveCrash', "Extension host terminated because it was not responsive.");
		}
		this._messageService.show(Severity.Error, {
			message: message,
			actions: [
				openDevTools,
				restart
			]
		});
	}

	private _createExtensionHostCustomers(protocol: IMessagePassingProtocol): ExtHostExtensionServiceShape {

		this._extensionHostProcessThreadService = this._instantiationService.createInstance(MainThreadService, protocol);
		const extHostContext: IExtHostContext = this._extensionHostProcessThreadService;

		// Named customers
		const namedCustomers = ExtHostCustomersRegistry.getNamedCustomers();
		for (let i = 0, len = namedCustomers.length; i < len; i++) {
			const [id, ctor] = namedCustomers[i];
			const instance = this._instantiationService.createInstance(ctor, extHostContext);
			this._extensionHostProcessCustomers.push(instance);
			this._extensionHostProcessThreadService.set(id, instance);
		}

		// Customers
		const customers = ExtHostCustomersRegistry.getCustomers();
		for (let i = 0, len = customers.length; i < len; i++) {
			const ctor = customers[i];
			const instance = this._instantiationService.createInstance(ctor, extHostContext);
			this._extensionHostProcessCustomers.push(instance);
		}

		// Check that no named customers are missing
		const expected: ProxyIdentifier<any>[] = Object.keys(MainContext).map((key) => MainContext[key]);
		this._extensionHostProcessThreadService.assertRegistered(expected);

		return this._extensionHostProcessThreadService.get(ExtHostContext.ExtHostExtensionService);
	}

	// ---- begin IExtensionService

	public activateByEvent(activationEvent: string): TPromise<void> {
		if (this._installedExtensionsReady.isOpen()) {
			// Extensions have been scanned and interpreted

			if (!this._registry.containsActivationEvent(activationEvent)) {
				// There is no extension that is interested in this activation event
				return NO_OP_VOID_PROMISE;
			}

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._activateByEvent(activationEvent);
		} else {
			// Extensions have not been scanned yet.

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._installedExtensionsReady.wait().then(() => this._activateByEvent(activationEvent));
		}
	}

	protected _activateByEvent(activationEvent: string): TPromise<void> {
		if (this._extensionHostProcessFinishedActivateEvents[activationEvent] || !this._extensionHostProcessProxy) {
			return NO_OP_VOID_PROMISE;
		}
		return this._extensionHostProcessProxy.then((proxy) => {
			return proxy.value.$activateByEvent(activationEvent);
		}).then(() => {
			this._extensionHostProcessFinishedActivateEvents[activationEvent] = true;
		});
	}

	public whenInstalledExtensionsRegistered(): TPromise<boolean> {
		return this._installedExtensionsReady.wait();
	}

	public getExtensions(): TPromise<IExtensionDescription[]> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getAllExtensionDescriptions();
		});
	}

	public readExtensionPointContributions<T>(extPoint: IExtensionPoint<T>): TPromise<ExtensionPointContribution<T>[]> {
		return this._installedExtensionsReady.wait().then(() => {
			let availableExtensions = this._registry.getAllExtensionDescriptions();

			let result: ExtensionPointContribution<T>[] = [], resultLen = 0;
			for (let i = 0, len = availableExtensions.length; i < len; i++) {
				let desc = availableExtensions[i];

				if (desc.contributes && hasOwnProperty.call(desc.contributes, extPoint.name)) {
					result[resultLen++] = new ExtensionPointContribution<T>(desc, desc.contributes[extPoint.name]);
				}
			}

			return result;
		});
	}

	public getExtensionsStatus(): { [id: string]: IExtensionsStatus; } {
		let result: { [id: string]: IExtensionsStatus; } = Object.create(null);
		if (this._registry) {
			const extensions = this._registry.getAllExtensionDescriptions();
			for (let i = 0, len = extensions.length; i < len; i++) {
				const extension = extensions[i];
				const id = extension.id;
				result[id] = {
					messages: this._extensionsMessages[id],
					activationTimes: this._extensionHostProcessActivationTimes[id],
					runtimeErrors: this._extensionHostExtensionRuntimeErrors[id],
				};
			}
		}
		return result;
	}

	public startExtensionHostProfile(): TPromise<ProfileSession> {
		if (this._extensionHostProcessWorker) {
			let port = this._extensionHostProcessWorker.getInspectPort();
			if (port) {
				return this._instantiationService.createInstance(ExtensionHostProfiler, port).start();
			}
		}
		throw new Error('Extension host not running or no inspect port available');
	}

	// ---- end IExtensionService

	// --- impl

	private _scanAndHandleExtensions(): void {

		this._getRuntimeExtension()
			.then(runtimeExtensons => {
				this._registry = new ExtensionDescriptionRegistry(runtimeExtensons);

				let availableExtensions = this._registry.getAllExtensionDescriptions();
				let extensionPoints = ExtensionsRegistry.getExtensionPoints();

				let messageHandler = (msg: IMessage) => this._handleExtensionPointMessage(msg);

				for (let i = 0, len = extensionPoints.length; i < len; i++) {
					const clock = time(`handleExtensionPoint:${extensionPoints[i].name}`);
					try {
						ExtensionService._handleExtensionPoint(extensionPoints[i], availableExtensions, messageHandler);
					} finally {
						clock.stop();
					}
				}

				mark('extensionHostReady');
				this._installedExtensionsReady.open();
				this._onDidRegisterExtensions.fire(availableExtensions);
				this._onDidChangeExtensionsStatus.fire(availableExtensions.map(e => e.id));
			});
	}

	private _getRuntimeExtension(): TPromise<IExtensionDescription[]> {
		const log = new Logger((severity, source, message) => {
			this._logOrShowMessage(severity, this._isDev ? messageWithSource2(source, message) : message);
		});

		return ExtensionService._scanInstalledExtensions(this._instantiationService, this._messageService, this._environmentService, log)
			.then(({ system, user, development }) => {
				this._extensionEnablementService.migrateToIdentifiers(user); // TODO: @sandy Remove it after couple of milestones
				return this._extensionEnablementService.getDisabledExtensions()
					.then(disabledExtensions => {
						let result: { [extensionId: string]: IExtensionDescription; } = {};
						let extensionsToDisable: IExtensionIdentifier[] = [];
						let userMigratedSystemExtensions: IExtensionIdentifier[] = [{ id: BetterMergeId }];

						system.forEach((systemExtension) => {
							// Disabling system extensions is not supported
							result[systemExtension.id] = systemExtension;
						});

						user.forEach((userExtension) => {
							if (result.hasOwnProperty(userExtension.id)) {
								log.warn(userExtension.extensionFolderPath, nls.localize('overwritingExtension', "Overwriting extension {0} with {1}.", result[userExtension.id].extensionFolderPath, userExtension.extensionFolderPath));
							}
							if (disabledExtensions.every(disabled => !areSameExtensions(disabled, userExtension))) {
								// Check if the extension is changed to system extension
								let userMigratedSystemExtension = userMigratedSystemExtensions.filter(userMigratedSystemExtension => areSameExtensions(userMigratedSystemExtension, { id: userExtension.id }))[0];
								if (userMigratedSystemExtension) {
									extensionsToDisable.push(userMigratedSystemExtension);
								} else {
									result[userExtension.id] = userExtension;
								}
							}
						});

						development.forEach(developedExtension => {
							log.info('', nls.localize('extensionUnderDevelopment', "Loading development extension at {0}", developedExtension.extensionFolderPath));
							if (result.hasOwnProperty(developedExtension.id)) {
								log.warn(developedExtension.extensionFolderPath, nls.localize('overwritingExtension', "Overwriting extension {0} with {1}.", result[developedExtension.id].extensionFolderPath, developedExtension.extensionFolderPath));
							}
							// Do not disable extensions under development
							result[developedExtension.id] = developedExtension;
						});

						const runtimeExtensions = Object.keys(result).map(name => result[name]);

						this._telemetryService.publicLog('extensionsScanned', {
							totalCount: runtimeExtensions.length,
							disabledCount: disabledExtensions.length
						});

						if (extensionsToDisable.length) {
							return TPromise.join(extensionsToDisable.map(e => this._extensionEnablementService.setEnablement(e, EnablementState.Disabled)))
								.then(() => {
									this._storageService.store(BetterMergeDisabledNowKey, true);
									return runtimeExtensions;
								});
						} else {
							return runtimeExtensions;
						}
					});
			});
	}

	private _handleExtensionPointMessage(msg: IMessage) {

		if (!this._extensionsMessages[msg.source]) {
			this._extensionsMessages[msg.source] = [];
		}
		this._extensionsMessages[msg.source].push(msg);

		if (msg.source === this._environmentService.extensionDevelopmentPath) {
			// This message is about the extension currently being developed
			this._showMessageToUser(msg.type, messageWithSource(msg));
		} else {
			this._logMessageInConsole(msg.type, messageWithSource(msg));
		}

		if (!this._isDev && msg.extensionId) {
			const { type, extensionId, extensionPointId, message } = msg;
			/* __GDPR__
				"extensionsMessage" : {
					"type" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"extensionId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"extensionPointId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"message": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
				}
			*/
			this._telemetryService.publicLog('extensionsMessage', {
				type, extensionId, extensionPointId, message
			});
		}
	}

	private static async _validateExtensionsCache(instantiationService: IInstantiationService, messageService: IMessageService, environmentService: IEnvironmentService, cacheKey: string, input: ExtensionScannerInput): TPromise<void> {
		const cacheFolder = path.join(environmentService.userDataPath, MANIFEST_CACHE_FOLDER);
		const cacheFile = path.join(cacheFolder, cacheKey);

		const expected = await ExtensionScanner.scanExtensions(input, new NullLogger());

		const cacheContents = await this._readExtensionCache(environmentService, cacheKey);
		const actual = cacheContents.result;

		if (objects.equals(expected, actual)) {
			// Cache is valid and running with it is perfectly fine...
			return;
		}

		try {
			await pfs.del(cacheFile);
		} catch (err) {
			errors.onUnexpectedError(err);
			console.error(err);
		}

		let message = nls.localize('extensionCache.invalid', "Extensions have been modified on disk. Please reload the window.");
		messageService.show(Severity.Info, {
			message: message,
			actions: [
				instantiationService.createInstance(ReloadWindowAction, ReloadWindowAction.ID, ReloadWindowAction.LABEL),
				CloseAction
			]
		});
	}

	private static async _readExtensionCache(environmentService: IEnvironmentService, cacheKey: string): TPromise<IExtensionCacheData> {
		const cacheFolder = path.join(environmentService.userDataPath, MANIFEST_CACHE_FOLDER);
		const cacheFile = path.join(cacheFolder, cacheKey);

		try {
			const cacheRawContents = await pfs.readFile(cacheFile, 'utf8');
			return JSON.parse(cacheRawContents);
		} catch (err) {
			// That's ok...
		}

		return null;
	}

	private static async _writeExtensionCache(environmentService: IEnvironmentService, cacheKey: string, cacheContents: IExtensionCacheData): TPromise<void> {
		const cacheFolder = path.join(environmentService.userDataPath, MANIFEST_CACHE_FOLDER);
		const cacheFile = path.join(cacheFolder, cacheKey);

		try {
			await pfs.mkdirp(cacheFolder);
		} catch (err) {
			// That's ok...
		}

		try {
			await pfs.writeFile(cacheFile, JSON.stringify(cacheContents));
		} catch (err) {
			// That's ok...
		}
	}

	private static async _scanExtensionsWithCache(instantiationService: IInstantiationService, messageService: IMessageService, environmentService: IEnvironmentService, cacheKey: string, input: ExtensionScannerInput, log: ILog): TPromise<IExtensionDescription[]> {
		if (input.devMode) {
			// Do not cache when running out of sources...
			return ExtensionScanner.scanExtensions(input, log);
		}

		const cacheContents = await this._readExtensionCache(environmentService, cacheKey);
		if (cacheContents && ExtensionScannerInput.equals(cacheContents.input, input)) {
			// Validate the cache asynchronously after 5s
			setTimeout(async () => {
				try {
					await this._validateExtensionsCache(instantiationService, messageService, environmentService, cacheKey, input);
				} catch (err) {
					errors.onUnexpectedError(err);
				}
			}, 5000);
			return cacheContents.result;
		}

		const counterLogger = new CounterLogger(log);
		const result = await ExtensionScanner.scanExtensions(input, counterLogger);
		if (counterLogger.errorCnt === 0) {
			// Nothing bad happened => cache the result
			const cacheContents: IExtensionCacheData = {
				input: input,
				result: result
			};
			await this._writeExtensionCache(environmentService, cacheKey, cacheContents);
		}

		return result;
	}

	private static _scanInstalledExtensions(instantiationService: IInstantiationService, messageService: IMessageService, environmentService: IEnvironmentService, log: ILog): TPromise<{ system: IExtensionDescription[], user: IExtensionDescription[], development: IExtensionDescription[] }> {
		const version = pkg.version;
		const devMode = !!process.env['VSCODE_DEV'];
		const locale = platform.locale;

		const builtinExtensions = this._scanExtensionsWithCache(
			instantiationService,
			messageService,
			environmentService,
			BUILTIN_MANIFEST_CACHE_FILE,
			new ExtensionScannerInput(version, locale, devMode, SystemExtensionsRoot, true),
			log
		);

		const userExtensions = (
			environmentService.disableExtensions || !environmentService.extensionsPath
				? TPromise.as([])
				: this._scanExtensionsWithCache(
					instantiationService,
					messageService,
					environmentService,
					USER_MANIFEST_CACHE_FILE,
					new ExtensionScannerInput(version, locale, devMode, environmentService.extensionsPath, false),
					log
				)
		);

		// Always load developed extensions while extensions development
		const developedExtensions = (
			environmentService.isExtensionDevelopment
				? ExtensionScanner.scanOneOrMultipleExtensions(
					new ExtensionScannerInput(version, locale, devMode, environmentService.extensionDevelopmentPath, false), log
				)
				: TPromise.as([])
		);

		return TPromise.join([builtinExtensions, userExtensions, developedExtensions])
			.then((extensionDescriptions: IExtensionDescription[][]) => {
				const system = extensionDescriptions[0];
				const user = extensionDescriptions[1];
				const development = extensionDescriptions[2];
				return { system, user, development };
			}).then(null, err => {
				log.error('', err);
				return { system: [], user: [], development: [] };
			});
	}

	private static _handleExtensionPoint<T>(extensionPoint: ExtensionPoint<T>, availableExtensions: IExtensionDescription[], messageHandler: (msg: IMessage) => void): void {
		let users: IExtensionPointUser<T>[] = [], usersLen = 0;
		for (let i = 0, len = availableExtensions.length; i < len; i++) {
			let desc = availableExtensions[i];

			if (desc.contributes && hasOwnProperty.call(desc.contributes, extensionPoint.name)) {
				users[usersLen++] = {
					description: desc,
					value: desc.contributes[extensionPoint.name],
					collector: new ExtensionMessageCollector(messageHandler, desc, extensionPoint.name)
				};
			}
		}

		extensionPoint.acceptUsers(users);
	}

	private _showMessageToUser(severity: Severity, msg: string): void {
		if (severity === Severity.Error || severity === Severity.Warning) {
			this._messageService.show(severity, msg);
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	private _logMessageInConsole(severity: Severity, msg: string): void {
		if (severity === Severity.Error) {
			console.error(msg);
		} else if (severity === Severity.Warning) {
			console.warn(msg);
		} else {
			console.log(msg);
		}
	}

	// -- called by extension host

	public _logOrShowMessage(severity: Severity, msg: string): void {
		if (this._isDev) {
			this._showMessageToUser(severity, msg);
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	public _onExtensionActivated(extensionId: string, startup: boolean, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationEvent: string): void {
		this._extensionHostProcessActivationTimes[extensionId] = new ActivationTimes(startup, codeLoadingTime, activateCallTime, activateResolvedTime, activationEvent);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _onExtensionRuntimeError(extensionId: string, err: Error): void {
		if (!this._extensionHostExtensionRuntimeErrors[extensionId]) {
			this._extensionHostExtensionRuntimeErrors[extensionId] = [];
		}
		this._extensionHostExtensionRuntimeErrors[extensionId].push(err);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _addMessage(extensionId: string, severity: Severity, message: string): void {
		if (!this._extensionsMessages[extensionId]) {
			this._extensionsMessages[extensionId] = [];
		}
		this._extensionsMessages[extensionId].push({
			type: severity,
			message: message,
			source: null,
			extensionId: null,
			extensionPointId: null
		});
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}
}

interface IExtensionCacheData {
	input: ExtensionScannerInput;
	result: IExtensionDescription[];
}

export class Logger implements ILog {

	private readonly _messageHandler: (severity: Severity, source: string, message: string) => void;

	constructor(
		messageHandler: (severity: Severity, source: string, message: string) => void
	) {
		this._messageHandler = messageHandler;
	}

	public error(source: string, message: string): void {
		this._messageHandler(Severity.Error, source, message);
	}

	public warn(source: string, message: string): void {
		this._messageHandler(Severity.Warning, source, message);
	}

	public info(source: string, message: string): void {
		this._messageHandler(Severity.Info, source, message);
	}
}

class CounterLogger implements ILog {

	public errorCnt = 0;
	public warnCnt = 0;
	public infoCnt = 0;

	constructor(private readonly _actual: ILog) {
	}

	public error(source: string, message: string): void {
		this._actual.error(source, message);
	}

	public warn(source: string, message: string): void {
		this._actual.warn(source, message);
	}

	public info(source: string, message: string): void {
		this._actual.info(source, message);
	}
}

class NullLogger implements ILog {
	public error(source: string, message: string): void {
	}
	public warn(source: string, message: string): void {
	}
	public info(source: string, message: string): void {
	}
}
