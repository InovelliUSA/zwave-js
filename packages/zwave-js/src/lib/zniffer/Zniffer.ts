import {
	type CCParsingContext,
	CommandClass,
	Security2CCMessageEncapsulation,
	Security2CCNonceGet,
	Security2CCNonceReport,
	SecurityCCNonceReport,
	registerCCs,
} from "@zwave-js/cc";
import { DeviceConfig } from "@zwave-js/config";
import {
	CommandClasses,
	type FrameType,
	type HostIDs,
	type LogConfig,
	type LogContainer,
	MPDUHeaderType,
	type MaybeNotKnown,
	NODE_ID_BROADCAST,
	NODE_ID_BROADCAST_LR,
	type RSSI,
	SPANState,
	SecurityClass,
	SecurityManager,
	SecurityManager2,
	type SecurityManagers,
	type UnknownZWaveChipType,
	ZWaveError,
	ZWaveErrorCodes,
	ZnifferLRChannelConfig,
	ZnifferRegion,
	ZnifferRegionLegacy,
	getChipTypeAndVersion,
	isLongRangeNodeId,
	isZWaveError,
	sdkVersionGte,
	securityClassIsS2,
} from "@zwave-js/core";
import {
	type ZWaveSerialBindingFactory,
	type ZWaveSerialPortImplementation,
	ZnifferDataMessage,
	ZnifferFrameType,
	ZnifferGetFrequenciesRequest,
	ZnifferGetFrequenciesResponse,
	ZnifferGetFrequencyInfoRequest,
	ZnifferGetFrequencyInfoResponse,
	ZnifferGetLRChannelConfigInfoRequest,
	ZnifferGetLRChannelConfigInfoResponse,
	ZnifferGetLRChannelConfigsRequest,
	ZnifferGetLRChannelConfigsResponse,
	ZnifferGetLRRegionsRequest,
	ZnifferGetLRRegionsResponse,
	ZnifferGetVersionRequest,
	ZnifferGetVersionResponse,
	ZnifferMessage,
	ZnifferMessageType,
	ZnifferSerialFrameType,
	type ZnifferSerialStream,
	ZnifferSerialStreamFactory,
	ZnifferSetBaudRateRequest,
	ZnifferSetBaudRateResponse,
	ZnifferSetFrequencyRequest,
	ZnifferSetFrequencyResponse,
	ZnifferSetLRChannelConfigRequest,
	ZnifferSetLRChannelConfigResponse,
	ZnifferStartRequest,
	ZnifferStartResponse,
	ZnifferStopRequest,
	ZnifferStopResponse,
	isZWaveSerialPortImplementation,
	wrapLegacySerialBinding,
} from "@zwave-js/serial";
import {
	Bytes,
	TypedEventTarget,
	getEnumMemberName,
	isAbortError,
	isEnumMember,
	noop,
	num2hex,
	pick,
} from "@zwave-js/shared";
import {
	type DeferredPromise,
	createDeferredPromise,
} from "alcalzone-shared/deferred-promise";
import type { ZWaveOptions } from "../driver/ZWaveOptions.js";
import { ZnifferLogger } from "../log/Zniffer.js";
import {
	BeamStop,
	type CorruptedFrame,
	type Frame,
	LongRangeBeamStart,
	LongRangeMPDU,
	ZWaveBeamStart,
	ZWaveMPDU,
	beamToFrame,
	mpduToFrame,
	parseBeamFrame,
	parseMPDU,
	znifferDataMessageToCorruptedFrame,
} from "./MPDU.js";

// Force-load all Command Classes:
registerCCs();

const logo: string = `
███████╗ ███╗   ██╗ ██╗ ██████╗ ██████╗ ███████╗ ██████╗          ██╗ ███████╗
╚══███╔╝ ████╗  ██║ ██║ ██╔═══╝ ██╔═══╝ ██╔════╝ ██╔══██╗         ██║ ██╔════╝
  ███╔╝  ██╔██╗ ██║ ██║ ████╗   ████╗   █████╗   ██████╔╝         ██║ ███████╗
 ███╔╝   ██║╚██╗██║ ██║ ██╔═╝   ██╔═╝   ██╔══╝   ██╔══██╗    ██   ██║ ╚════██║
███████╗ ██║ ╚████║ ██║ ██║     ██║     ███████╗ ██║  ██║    ╚█████╔╝ ███████║
╚══════╝ ╚═╝  ╚═══╝ ╚═╝ ╚═╝     ╚═╝     ╚══════╝ ╚═╝  ╚═╝     ╚════╝  ╚══════╝
`.trim();

export interface ZnifferEventCallbacks {
	ready: () => void;
	error: (err: Error) => void;
	frame: (frame: Frame, rawData: Uint8Array) => void;
	"corrupted frame": (err: CorruptedFrame, rawData: Uint8Array) => void;
}

export type ZnifferEvents = Extract<keyof ZnifferEventCallbacks, string>;

interface AwaitedThing<T> {
	handler: (thing: T) => void;
	timeout?: NodeJS.Timeout;
	predicate: (msg: T) => boolean;
}

type AwaitedMessageEntry = AwaitedThing<ZnifferMessage>;

export interface ZnifferOptions {
	/**
	 * Optional log configuration
	 */
	logConfig?: Partial<LogConfig>;

	/** Security keys for decrypting Z-Wave traffic */
	securityKeys?: ZWaveOptions["securityKeys"];
	/** Security keys for decrypting Z-Wave Long Range traffic */
	securityKeysLongRange?: ZWaveOptions["securityKeysLongRange"];

	host?: ZWaveOptions["host"];

	/**
	 * The RSSI values reported by the Zniffer are not actual RSSI values.
	 * They can be converted to dBm, but the conversion is chip dependent and not documented for 700/800 series Zniffers.
	 *
	 * Set this option to `true` enable the conversion. Otherwise the raw values from the Zniffer will be used.
	 */
	convertRSSI?: boolean;

	/**
	 * The frequency to initialize the Zniffer with. If not specified, the current setting will be kept.
	 *
	 * On 700/800 series Zniffers, this value matches the {@link ZnifferRegion}.
	 *
	 * On 400/500 series Zniffers, the value is firmware-specific.
	 * Supported regions and their names have to be queried using the `getFrequencies` and `getFrequencyInfo(frequency)` commands.
	 */
	defaultFrequency?: number;

	/**
	 * The LR channel configuration to initialize the Zniffer with. If not specified, the current setting will be kept.
	 *
	 * This is only supported for 800 series Zniffers with LR support
	 */
	defaultLRChannelConfig?: ZnifferLRChannelConfig;

	/** Limit the number of frames that are kept in memory. */
	maxCapturedFrames?: number;
}

function is700PlusSeries(
	chipType: string | UnknownZWaveChipType,
): boolean {
	if (typeof chipType !== "string") {
		return chipType.type >= 0x07;
	}

	const chipTypeNumeric = getChipTypeAndVersion(chipType);
	if (chipTypeNumeric) {
		return chipTypeNumeric.type >= 0x07;
	}

	return false;
}

function tryConvertRSSI(
	rssi: number,
	chipType: string | UnknownZWaveChipType,
): number {
	// For 400/500 series, the conversion is documented in the Zniffer user guide.
	// The conversion for 700/800 series was reverse-engineered from the Zniffer firmware.
	// Here, we assume that only these two representations exist:
	if (is700PlusSeries(chipType)) {
		return rssi * 4 - 256;
	} else {
		return rssi * 1.5 - 153.5;
	}
}

interface CapturedData {
	timestamp: Date;
	rawData: Uint8Array;
	frameData: Uint8Array;
	parsedFrame?: Frame | CorruptedFrame;
}

export interface CapturedFrame {
	timestamp: Date;
	frameData: Uint8Array;
	parsedFrame: Frame | CorruptedFrame;
}

export class Zniffer extends TypedEventTarget<ZnifferEventCallbacks> {
	public constructor(
		private port:
			| string
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			| ZWaveSerialPortImplementation
			| ZWaveSerialBindingFactory,
		options: ZnifferOptions = {},
	) {
		super();

		// Ensure the given serial port is valid
		if (
			typeof port !== "string"
			&& !isZWaveSerialPortImplementation(port)
		) {
			throw new ZWaveError(
				`The port must be a string or a valid custom serial port implementation!`,
				ZWaveErrorCodes.Driver_InvalidOptions,
			);
		}

		this._options = options;

		this._active = false;

		this.parsingContext = {
			getHighestSecurityClass(
				_nodeId: number,
			): MaybeNotKnown<SecurityClass> {
				return SecurityClass.S2_AccessControl;
			},

			hasSecurityClass(
				_nodeId: number,
				_securityClass: SecurityClass,
			): MaybeNotKnown<boolean> {
				// We don't actually know. Attempt parsing with all security classes
				return true;
			},

			setSecurityClass(
				_nodeId: number,
				_securityClass: SecurityClass,
				_granted: boolean,
			): void {
				// Do nothing
			},

			getDeviceConfig(_nodeId: number): DeviceConfig | undefined {
				// Disable strict validation while parsing certain CCs
				// Most of this stuff isn't actually needed, only the compat flags...
				return new DeviceConfig(
					"unknown.json",
					false,
					"UNKNOWN_MANUFACTURER",
					0x0000,
					"UNKNOWN_PRODUCT",
					"UNKNOWN_DESCRIPTION",
					[],
					{
						min: "0.0",
						max: "255.255",
					},
					true,
					undefined,
					undefined,
					undefined,
					undefined,
					// ...down here:
					{
						disableStrictEntryControlDataValidation: true,
						disableStrictMeasurementValidation: true,
					},
				);
			},
		};
	}

	private _options: ZnifferOptions;

	/**
	 * The host bindings used to access file system etc.
	 */
	// This is set during `init()` and should not be accessed before
	private bindings!: Omit<
		Required<
			NonNullable<ZWaveOptions["host"]>
		>,
		"db"
	>;

	private serialFactory: ZnifferSerialStreamFactory | undefined;
	/** The serial port instance */
	private serial: ZnifferSerialStream | undefined;

	private parsingContext: Omit<
		CCParsingContext,
		keyof HostIDs | "sourceNodeId" | "frameType" | keyof SecurityManagers
	>;

	private _destroyPromise: DeferredPromise<void> | undefined;
	private get wasDestroyed(): boolean {
		return !!this._destroyPromise;
	}

	private _chipType: string | UnknownZWaveChipType | undefined;

	private _currentFrequency: number | undefined;
	/** The currently configured frequency */
	public get currentFrequency(): number | undefined {
		return this._currentFrequency;
	}

	private _supportedFrequencies: Map<number, string> = new Map();
	/** A map of supported frequency identifiers and their names */
	public get supportedFrequencies(): ReadonlyMap<number, string> {
		return this._supportedFrequencies;
	}

	private _lrRegions: Set<number> = new Set();
	/** A list regions that are Long Range capable */
	public get lrRegions(): ReadonlySet<number> {
		return this._lrRegions;
	}

	private _currentLRChannelConfig: number | undefined;
	/** The currently configured Long Range channel configuration */
	public get currentLRChannelConfig(): number | undefined {
		return this._currentLRChannelConfig;
	}

	private _supportedLRChannelConfigs: Map<number, string> = new Map();
	/** A map of supported Long Range channel configurations and their names */
	public get supportedLRChannelConfigs(): ReadonlyMap<number, string> {
		return this._supportedLRChannelConfigs;
	}

	// This is set during `start()` and should not be accessed before
	private _logContainer!: LogContainer;
	// This is set during `start()` and should not be accessed before
	private znifferLog!: ZnifferLogger;

	/** The security managers for each node */
	private securityManagers: Map<number, {
		securityManager: SecurityManager | undefined;
		securityManager2: SecurityManager2 | undefined;
		securityManagerLR: SecurityManager2 | undefined;
	}> = new Map();

	/** A list of awaited messages */
	private awaitedMessages: AwaitedMessageEntry[] = [];

	private _active: boolean;
	/** Whether the Zniffer instance is currently capturing */
	public get active(): boolean {
		return this._active;
	}

	private _capturedFrames: CapturedData[] = [];

	/** A list of raw captured frames that can be saved to a .zlf file later */
	public get capturedFrames(): Readonly<CapturedFrame>[] {
		return this._capturedFrames.filter((f) => f.parsedFrame !== undefined)
			.map((f) => ({
				timestamp: f.timestamp,
				frameData: f.frameData,
				parsedFrame: f.parsedFrame!,
			}));
	}

	public async init(): Promise<void> {
		if (this.wasDestroyed) {
			throw new ZWaveError(
				"The Zniffer was destroyed. Create a new instance and initialize that one.",
				ZWaveErrorCodes.Driver_Destroyed,
			);
		}

		// Populate default bindings. This has to happen asynchronously, so the driver does not have a hard dependency
		// on Node.js internals
		this.bindings = {
			fs: this._options.host?.fs
				?? (await import("#default_bindings/fs")).fs,
			serial: this._options.host?.serial
				?? (await import("#default_bindings/serial")).serial,
			log: this._options.host?.log
				?? (await import("#default_bindings/log")).log,
		};

		// Initialize logging
		this._logContainer = this.bindings.log(this._options.logConfig);
		this.znifferLog = new ZnifferLogger(this, this._logContainer);

		// Open the serial port
		let binding: ZWaveSerialBindingFactory;
		if (typeof this.port === "string") {
			if (
				typeof this.bindings.serial.createFactoryByPath === "function"
			) {
				this.znifferLog.print(`opening serial port ${this.port}`);
				binding = await this.bindings.serial.createFactoryByPath(
					this.port,
				);
			} else {
				throw new ZWaveError(
					"This platform does not support creating a serial connection by path",
					ZWaveErrorCodes.Driver_Failed,
				);
			}
		} else if (isZWaveSerialPortImplementation(this.port)) {
			this.znifferLog.print(
				"opening serial port using the provided custom implementation",
			);
			this.znifferLog.print(
				"This is deprecated! Switch to the factory pattern instead.",
				"warn",
			);
			binding = wrapLegacySerialBinding(this.port);
		} else {
			this.znifferLog.print(
				"opening serial port using the provided custom factory",
			);
			binding = this.port;
		}
		this.serialFactory = new ZnifferSerialStreamFactory(
			binding,
			this._logContainer,
		);

		this.serial = await this.serialFactory.createStream();
		void this.handleSerialData(this.serial);

		this.znifferLog.print(logo, "info");

		await this.stop();

		const versionInfo = await this.getVersion();
		this._chipType = versionInfo.chipType;
		this.znifferLog.print(
			`received Zniffer info:
  Chip type:       ${
				typeof versionInfo.chipType === "string"
					? versionInfo.chipType
					: `unknown (${num2hex(versionInfo.chipType.type)}, ${
						num2hex(versionInfo.chipType.version)
					})`
			}
  Zniffer version: ${versionInfo.majorVersion}.${versionInfo.minorVersion}`,
			"info",
		);

		await this.setBaudrate(0);

		const freqs = await this.getFrequencies();
		this._currentFrequency = freqs.currentFrequency;
		if (is700PlusSeries(this._chipType)) {
			// The frequencies match the ZnifferRegion enum
			for (const freq of freqs.supportedFrequencies) {
				this._supportedFrequencies.set(
					freq,
					getEnumMemberName(ZnifferRegion, freq),
				);
			}
			// ... but there might be unknown regions. Query those from the Zniffer
			const unknownRegions = freqs.supportedFrequencies.filter((f) =>
				!isEnumMember(ZnifferRegion, f)
			);
			for (const freq of unknownRegions) {
				const freqInfo = await this.getFrequencyInfo(freq);
				this._supportedFrequencies.set(freq, freqInfo.frequencyName);
			}
		} else if (
			// Version 2.55+ supports querying the frequency names
			sdkVersionGte(
				`${versionInfo.majorVersion}.${versionInfo.minorVersion}`,
				"2.55",
			)
		) {
			// The frequencies are firmware-specific. Query them from the Zniffer
			for (const freq of freqs.supportedFrequencies) {
				const freqInfo = await this.getFrequencyInfo(freq);
				this._supportedFrequencies.set(freq, freqInfo.frequencyName);
			}
		} else {
			// The frequencies match the ZnifferRegionLegacy enum, and their info cannot be queried
			for (const freq of freqs.supportedFrequencies) {
				this._supportedFrequencies.set(
					freq,
					getEnumMemberName(ZnifferRegionLegacy, freq),
				);
			}
		}

		this.znifferLog.print(
			`received frequency info:
current frequency: ${
				this._supportedFrequencies.get(freqs.currentFrequency)
					?? `unknown (${num2hex(freqs.currentFrequency)})`
			}
supported frequencies: ${
				[...this._supportedFrequencies].map(([region, name]) =>
					`\n  · ${region.toString().padStart(2, " ")}: ${name}`
				).join("")
			}`,
			"info",
		);

		if (
			typeof this._options.defaultFrequency === "number"
			&& freqs.currentFrequency !== this._options.defaultFrequency
			&& this._supportedFrequencies.has(this._options.defaultFrequency)
		) {
			await this.setFrequency(this._options.defaultFrequency);
		}

		if (
			sdkVersionGte(
				`${versionInfo.majorVersion}.${versionInfo.minorVersion}`,
				"10.22",
			)
		) {
			// Simplicity SDK 2024.6  added commands to query and configure LR channels
			for (const region of await this.getLRRegions()) {
				this._lrRegions.add(region);
			}

			const channels = await this.getLRChannelConfigs();
			this._currentLRChannelConfig = channels.currentConfig;
			// The channel configs match the ZnifferLRChannelConfig enum
			for (const channel of channels.supportedConfigs) {
				this._supportedLRChannelConfigs.set(
					channel,
					getEnumMemberName(ZnifferLRChannelConfig, channel),
				);
			}
			// ... but there might be unknown configurations. Query those from the Zniffer
			const unknownConfigs = channels.supportedConfigs.filter((f) =>
				!isEnumMember(ZnifferLRChannelConfig, f)
			);
			for (const channel of unknownConfigs) {
				const channelInfo = await this.getLRChannelConfigInfo(
					channel,
				);
				this._supportedLRChannelConfigs.set(
					channel,
					channelInfo.configName,
				);
			}

			this.znifferLog.print(
				`received LR channel info:
	current channel: ${
					this._supportedLRChannelConfigs.get(
						this._currentLRChannelConfig,
					)
						?? `unknown (${num2hex(this._currentLRChannelConfig)})`
				}
	supported channels: ${
					[...this._supportedLRChannelConfigs].map((
						[channel, name],
					) => `\n  · ${channel.toString()}: ${name}`).join("")
				}`,
				"info",
			);

			if (
				this._lrRegions.has(this._currentFrequency)
				&& typeof this._options.defaultLRChannelConfig === "number"
				&& this._currentLRChannelConfig
					!== this._options.defaultLRChannelConfig
				&& this._supportedLRChannelConfigs.has(
					this._options.defaultLRChannelConfig,
				)
			) {
				await this.setLRChannelConfig(
					this._options.defaultLRChannelConfig,
				);
			}
		}

		this.emit("ready");
	}

	private async handleSerialData(serial: ZnifferSerialStream): Promise<void> {
		try {
			for await (const frame of serial.readable) {
				setImmediate(() => {
					if (frame.type === ZnifferSerialFrameType.SerialAPI) {
						void this.serialport_onData(frame.data);
					} else {
						// Handle discarded data?
					}
				});
			}
		} catch (e) {
			if (isAbortError(e)) {
				return;
			} else if (
				isZWaveError(e) && e.code === ZWaveErrorCodes.Driver_Failed
			) {
				this.emit("error", e);
				return this.destroy();
			}
			throw e;
		}
	}

	/**
	 * Is called when the serial port has received a Zniffer frame
	 */
	private async serialport_onData(
		data: Uint8Array,
	): Promise<void> {
		let msg: ZnifferMessage | undefined;
		try {
			msg = ZnifferMessage.parse(data);
		} catch (e: any) {
			console.error(e);
			return;
		}

		if (msg.type === ZnifferMessageType.Command) {
			this.handleResponse(msg);
		} else {
			const dataMsg = msg as ZnifferDataMessage;
			const capture: CapturedData = {
				timestamp: new Date(),
				rawData: data,
				frameData: dataMsg.payload,
			};
			this._capturedFrames.push(capture);
			if (
				this._options.maxCapturedFrames != undefined
				&& this._capturedFrames.length > this._options.maxCapturedFrames
			) {
				this._capturedFrames.shift();
			}
			await this.handleDataMessage(dataMsg, capture);
		}
	}

	/**
	 * Is called when a Request-type message was received
	 */
	private handleResponse(msg: ZnifferMessage): void {
		// Check if we have a dynamic handler waiting for this message
		for (const entry of this.awaitedMessages) {
			if (entry.predicate(msg)) {
				// We do
				entry.handler(msg);
				return;
			}
		}
	}

	/**
	 * Is called when a Request-type message was received
	 */
	private async handleDataMessage(
		msg: ZnifferDataMessage,
		capture: CapturedData,
	): Promise<void> {
		try {
			const frame = await this.parseFrame(msg);
			capture.parsedFrame = frame.external;

			if (
				frame.internal instanceof ZWaveBeamStart
				|| frame.internal instanceof LongRangeBeamStart
				|| frame.internal instanceof BeamStop
			) {
				this.znifferLog.beam(frame.internal);
				this.emit("frame", frame.external as Frame, capture.frameData);
				return;
			}

			if (frame.internal === undefined) {
				// Corrupted frame, expose as a CRC error
				this.znifferLog.crcError(msg);
				this.emit(
					"corrupted frame",
					frame.external as CorruptedFrame,
					capture.frameData,
				);
				return;
			}

			if (
				frame.internal instanceof ZWaveMPDU
				|| frame.internal instanceof LongRangeMPDU
			) {
				this.znifferLog.mpdu(frame.internal, frame.cc);
				this.emit("frame", frame.external as Frame, capture.frameData);
				return;
			}
		} catch (e: any) {
			console.error(e);
		}
	}

	/**
	 * Waits until a certain serial message is received or a timeout has elapsed. Returns the received message.
	 * @param timeout The number of milliseconds to wait. If the timeout elapses, the returned promise will be rejected
	 * @param predicate A predicate function to test all incoming messages.
	 */
	private waitForMessage<T extends ZnifferMessage>(
		predicate: (msg: ZnifferMessage) => boolean,
		timeout: number,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const promise = createDeferredPromise<ZnifferMessage>();
			const entry: AwaitedMessageEntry = {
				predicate,
				handler: (msg) => promise.resolve(msg),
				timeout: undefined,
			};
			this.awaitedMessages.push(entry);
			const removeEntry = () => {
				if (entry.timeout) clearTimeout(entry.timeout);
				const index = this.awaitedMessages.indexOf(entry);
				if (index !== -1) this.awaitedMessages.splice(index, 1);
			};
			// When the timeout elapses, remove the wait entry and reject the returned Promise
			entry.timeout = setTimeout(() => {
				removeEntry();
				reject(
					new ZWaveError(
						`Received no matching message within the provided timeout!`,
						ZWaveErrorCodes.Controller_Timeout,
					),
				);
			}, timeout);
			// When the promise is resolved, remove the wait entry and resolve the returned Promise
			void promise.then((cc) => {
				removeEntry();
				resolve(cc as T);
			});
		});
	}

	private async getVersion() {
		const req = new ZnifferGetVersionRequest();
		await this.serial?.writeAsync(req.serialize());
		const res = await this.waitForMessage<ZnifferGetVersionResponse>(
			(msg) => msg instanceof ZnifferGetVersionResponse,
			1000,
		);

		return pick(res, ["chipType", "majorVersion", "minorVersion"]);
	}

	private async getFrequencies() {
		const req = new ZnifferGetFrequenciesRequest();
		await this.serial?.writeAsync(req.serialize());
		const res = await this.waitForMessage<ZnifferGetFrequenciesResponse>(
			(msg) => msg instanceof ZnifferGetFrequenciesResponse,
			1000,
		);

		return pick(res, [
			"currentFrequency",
			"supportedFrequencies",
		]);
	}

	public async setFrequency(frequency: number): Promise<void> {
		const req = new ZnifferSetFrequencyRequest({ frequency });
		await this.serial?.writeAsync(req.serialize());
		await this.waitForMessage<ZnifferSetFrequencyResponse>(
			(msg) => msg instanceof ZnifferSetFrequencyResponse,
			1000,
		);
		this._currentFrequency = frequency;
	}

	private async getFrequencyInfo(frequency: number) {
		const req = new ZnifferGetFrequencyInfoRequest({ frequency });
		await this.serial?.writeAsync(req.serialize());
		const res = await this.waitForMessage<ZnifferGetFrequencyInfoResponse>(
			(msg) =>
				msg instanceof ZnifferGetFrequencyInfoResponse
				&& msg.frequency === frequency,
			1000,
		);

		return pick(res, ["numChannels", "frequencyName"]);
	}

	private async getLRRegions() {
		const req = new ZnifferGetLRRegionsRequest();
		await this.serial?.writeAsync(req.serialize());
		const res = await this.waitForMessage<ZnifferGetLRRegionsResponse>(
			(msg) => msg instanceof ZnifferGetLRRegionsResponse,
			1000,
		);

		return res.regions;
	}

	private async getLRChannelConfigs() {
		const req = new ZnifferGetLRChannelConfigsRequest();
		await this.serial?.writeAsync(req.serialize());
		const res = await this.waitForMessage<
			ZnifferGetLRChannelConfigsResponse
		>(
			(msg) => msg instanceof ZnifferGetLRChannelConfigsResponse,
			1000,
		);

		return pick(res, [
			"currentConfig",
			"supportedConfigs",
		]);
	}

	public async setLRChannelConfig(channelConfig: number): Promise<void> {
		if (
			this._currentFrequency == undefined
			|| !this._lrRegions.has(this._currentFrequency)
		) {
			throw new ZWaveError(
				`The LR channel configuration can only be set for LR regions!`,
				ZWaveErrorCodes.Controller_NotSupported,
			);
		}

		const req = new ZnifferSetLRChannelConfigRequest({ channelConfig });
		await this.serial?.writeAsync(req.serialize());
		await this.waitForMessage<ZnifferSetLRChannelConfigResponse>(
			(msg) => msg instanceof ZnifferSetLRChannelConfigResponse,
			1000,
		);
		this._currentLRChannelConfig = channelConfig;
	}

	private async getLRChannelConfigInfo(channelConfig: number) {
		const req = new ZnifferGetLRChannelConfigInfoRequest({ channelConfig });
		await this.serial?.writeAsync(req.serialize());
		const res = await this.waitForMessage<
			ZnifferGetLRChannelConfigInfoResponse
		>(
			(msg) =>
				msg instanceof ZnifferGetLRChannelConfigInfoResponse
				&& msg.channelConfig === channelConfig,
			1000,
		);

		return pick(res, ["numChannels", "configName"]);
	}

	/** Starts the capture and discards all previously captured frames */
	public async start(): Promise<void> {
		if (this.wasDestroyed) {
			throw new ZWaveError(
				"The Zniffer is not ready or has been destroyed",
				ZWaveErrorCodes.Driver_NotReady,
			);
		}

		if (this._active) return;
		this._capturedFrames = [];
		this._active = true;

		const req = new ZnifferStartRequest();
		await this.serial?.writeAsync(req.serialize());
		await this.waitForMessage<ZnifferStartResponse>(
			(msg) => msg instanceof ZnifferStartResponse,
			1000,
		);
	}

	public async stop(): Promise<void> {
		if (!this._active) return;
		this._active = false;

		if (!this.serial) return;

		const req = new ZnifferStopRequest();
		await this.serial?.writeAsync(req.serialize());
		await this.waitForMessage<ZnifferStopResponse>(
			(msg) => msg instanceof ZnifferStopResponse,
			1000,
		);
	}

	private async setBaudrate(baudrate: 0): Promise<void> {
		const req = new ZnifferSetBaudRateRequest({ baudrate });
		await this.serial?.writeAsync(req.serialize());
		await this.waitForMessage<ZnifferSetBaudRateResponse>(
			(msg) => msg instanceof ZnifferSetBaudRateResponse,
			1000,
		);
	}

	private async getSecurityManagers(
		sourceNodeId: number,
	) {
		if (this.securityManagers.has(sourceNodeId)) {
			return this.securityManagers.get(sourceNodeId)!;
		}
		// Initialize security
		// Set up the S0 security manager. We can only do that after the controller
		// interview because we need to know the controller node id.
		const S0Key = this._options.securityKeys?.S0_Legacy;
		let securityManager: SecurityManager | undefined;
		if (S0Key) {
			// this.znifferLog.print(
			// 	"Network key for S0 configured, enabling S0 security manager...",
			// );
			securityManager = new SecurityManager({
				networkKey: S0Key,
				// FIXME: Track nonces separately for each destination node
				ownNodeId: sourceNodeId,
				nonceTimeout: Number.POSITIVE_INFINITY,
			});
			// } else {
			// 	this.znifferLog.print(
			// 		"No network key for S0 configured, cannot decrypt communication from secure (S0) devices!",
			// 		"warn",
			// 	);
		}

		let securityManager2: SecurityManager2 | undefined;
		if (
			this._options.securityKeys
			// Only set it up if we have security keys for at least one S2 security class
			&& Object.keys(this._options.securityKeys).some(
				(key) =>
					key.startsWith("S2_")
					&& key in SecurityClass
					&& securityClassIsS2((SecurityClass as any)[key]),
			)
		) {
			// this.znifferLog.print(
			// 	"At least one network key for S2 configured, enabling S2 security manager...",
			// );
			securityManager2 = await SecurityManager2.create();
			// Small hack: Zniffer does not care about S2 duplicates
			securityManager2.isDuplicateSinglecast = () => false;

			// Set up all keys
			for (
				const secClass of [
					"S2_Unauthenticated",
					"S2_Authenticated",
					"S2_AccessControl",
					"S0_Legacy",
				] as const
			) {
				const key = this._options.securityKeys[secClass];
				if (key) {
					await securityManager2.setKey(
						SecurityClass[secClass],
						key,
					);
				}
			}
			// } else {
			// 	this.znifferLog.print(
			// 		"No network key for S2 configured, cannot decrypt communication from secure (S2) devices!",
			// 		"warn",
			// 	);
		}

		let securityManagerLR: SecurityManager2 | undefined;
		if (
			this._options.securityKeysLongRange?.S2_AccessControl
			|| this._options.securityKeysLongRange?.S2_Authenticated
		) {
			// this.znifferLog.print(
			// 	"At least one network key for Z-Wave Long Range configured, enabling security manager...",
			// );
			securityManagerLR = await SecurityManager2.create();
			// Small hack: Zniffer does not care about S2 duplicates
			securityManagerLR.isDuplicateSinglecast = () => false;

			// Set up all keys
			if (this._options.securityKeysLongRange?.S2_AccessControl) {
				await securityManagerLR.setKey(
					SecurityClass.S2_AccessControl,
					this._options.securityKeysLongRange.S2_AccessControl,
				);
			}
			if (this._options.securityKeysLongRange?.S2_Authenticated) {
				await securityManagerLR.setKey(
					SecurityClass.S2_Authenticated,
					this._options.securityKeysLongRange.S2_Authenticated,
				);
			}
			// } else {
			// 	this.znifferLog.print(
			// 		"No network key for Z-Wave Long Range configured, cannot decrypt Long Range communication!",
			// 		"warn",
			// 	);
		}

		const ret = {
			securityManager,
			securityManager2,
			securityManagerLR,
		};
		this.securityManagers.set(sourceNodeId, ret);
		return ret;
	}

	/** Clears the list of captured frames */
	public clearCapturedFrames(): void {
		this._capturedFrames = [];
	}

	/**
	 * Get the captured frames in the official Zniffer application format.
	 * @param frameFilter Optional predicate function to filter the frames included in the capture
	 */
	public getCaptureAsZLFBuffer(
		frameFilter?: (frame: CapturedFrame) => boolean,
	): Uint8Array {
		// Mimics the current Zniffer software, without using features like sessions and comments
		const header = new Bytes(2048).fill(0);
		header[0] = 0x68; // zniffer version
		header.writeUInt16BE(0x2312, 0x07fe); // checksum
		let filteredFrames = this._capturedFrames;
		if (frameFilter) {
			filteredFrames = filteredFrames.filter((f) =>
				// Always include Zniffer-protocol frames
				f.parsedFrame == undefined
				// Apply the filter to all other frames
				|| frameFilter({
					frameData: f.frameData,
					parsedFrame: f.parsedFrame,
					timestamp: f.timestamp,
				})
			);
		}
		return Bytes.concat([
			header,
			...filteredFrames.map(captureToZLFEntry),
		]);
	}

	/**
	 * Saves the captured frames in a `.zlf` file that can be read by the official Zniffer application.
	 * @param frameFilter Optional predicate function to filter the frames included in the capture
	 */
	public async saveCaptureToFile(
		filePath: string,
		frameFilter?: (frame: CapturedFrame) => boolean,
	): Promise<void> {
		await this.bindings.fs.writeFile(
			filePath,
			this.getCaptureAsZLFBuffer(frameFilter),
		);
	}

	/**
	 * Terminates the Zniffer instance and closes the underlying serial connection.
	 * Must be called under any circumstances.
	 */
	public async destroy(): Promise<void> {
		// Ensure this is only called once and all subsequent calls block
		if (this._destroyPromise) return this._destroyPromise;
		this._destroyPromise = createDeferredPromise();

		this.znifferLog.print("Destroying Zniffer instance...");

		if (this._active) {
			await this.stop().catch(noop);
		}

		if (this.serial != undefined) {
			// Avoid spewing errors if the port was in the middle of receiving something
			if (this.serial.isOpen) await this.serial.close();
			this.serial = undefined;
		}

		this.znifferLog.print("Zniffer instance destroyed");

		// destroy loggers as the very last thing
		this._logContainer.destroy();

		this._destroyPromise.resolve();
	}

	/**
	 * Loads captured frames from a `.zlf` file that was written by the official Zniffer application or Z-Wave JS.
	 */
	public async loadCaptureFromFile(filePath: string): Promise<void> {
		const buffer = await this.bindings.fs.readFile(filePath);
		await this.loadCaptureFromBuffer(buffer);
	}

	/**
	 * Load captured frames from a buffer
	 */
	public async loadCaptureFromBuffer(buffer: Uint8Array): Promise<void> {
		// Parse and validate header
		let { bytesRead: offset } = parseZLFHeader(buffer);

		this.clearCapturedFrames();
		let accumulator: CapturedData | undefined;

		while (offset < buffer.length) {
			const {
				bytesRead,
				complete,
				type,
				entry,
				msg,
				accumulator: newAccumulator,
			} = parseZLFEntry(
				buffer,
				offset,
				accumulator,
			);
			// Avoid infinite loops
			if (bytesRead <= 0) break;
			offset += bytesRead;

			if (complete) {
				accumulator = undefined;
			} else {
				accumulator = newAccumulator;
				continue;
			}

			if (type === ZnifferMessageType.Data) {
				entry.parsedFrame =
					// FIXME: Figure out which values the Zniffer application actually stores
					// as RSSI. Both the attempted conversion and the raw values seem wrong.
					(await this.parseFrame(msg, false)).external;
				this._capturedFrames.push(entry);
			}
		}
	}

	private async parseFrame(
		msg: ZnifferDataMessage,
		convertRSSI: boolean = this._options.convertRSSI ?? false,
	): Promise<{
		internal: any;
		cc?: CommandClass;
		external: Frame | CorruptedFrame;
	}> {
		let convertedRSSI: RSSI | undefined;
		if (convertRSSI && this._chipType) {
			convertedRSSI = tryConvertRSSI(
				msg.rssiRaw,
				this._chipType,
			);
		}

		// Short-circuit if we're dealing with beam frames
		if (
			msg.frameType === ZnifferFrameType.BeamStart
			|| msg.frameType === ZnifferFrameType.BeamStop
		) {
			const beam = parseBeamFrame(msg);
			beam.frameInfo.rssi = convertedRSSI;
			return {
				internal: beam,
				external: beamToFrame(beam),
			};
		}

		// Only handle messages with a valid checksum, expose the others as CRC errors
		if (!msg.checksumOK) {
			return {
				internal: undefined,
				external: znifferDataMessageToCorruptedFrame(msg),
			};
		}

		const mpdu = parseMPDU(msg);
		mpdu.frameInfo.rssi = convertedRSSI;

		// Try to decode the CC while assuming the role of the receiver
		let destSecurityManager: SecurityManager | undefined;
		let destSecurityManager2: SecurityManager2 | undefined;
		let destSecurityManagerLR: SecurityManager2 | undefined;
		// Only frames with a destination node id contains something that requires access to the own node ID
		let destNodeId = 0xff;

		let cc: CommandClass | undefined;

		// FIXME: Cache data => parsed CC, so we can understand re-transmitted S2 frames

		if (
			mpdu.payload.length > 0
			&& mpdu.headerType !== MPDUHeaderType.Acknowledgement
		) {
			if ("destinationNodeId" in mpdu) {
				destNodeId = mpdu.destinationNodeId;
				({
					securityManager: destSecurityManager,
					securityManager2: destSecurityManager2,
					securityManagerLR: destSecurityManagerLR,
				} = await this.getSecurityManagers(mpdu.destinationNodeId));
			}

			// TODO: Support parsing multicast S2 frames
			const frameType: FrameType =
				mpdu.headerType === MPDUHeaderType.Multicast
					? "multicast"
					: (destNodeId === NODE_ID_BROADCAST
							|| destNodeId === NODE_ID_BROADCAST_LR)
					? "broadcast"
					: "singlecast";
			try {
				cc = await CommandClass.parse(
					mpdu.payload,
					{
						homeId: mpdu.homeId,
						ownNodeId: destNodeId,
						sourceNodeId: mpdu.sourceNodeId,
						frameType,
						securityManager: destSecurityManager,
						securityManager2: destSecurityManager2,
						securityManagerLR: destSecurityManagerLR,
						...this.parsingContext,
					},
				);
			} catch (e: any) {
				// Ignore
				console.error(e.stack);
			}
		}

		// Update the security managers when nonces are exchanged, so we can
		// decrypt the communication
		if (cc?.ccId === CommandClasses["Security 2"]) {
			const securityManagers = await this.getSecurityManagers(
				mpdu.sourceNodeId,
			);
			const isLR = isLongRangeNodeId(mpdu.sourceNodeId)
				|| isLongRangeNodeId(destNodeId);
			const senderSecurityManager = isLR
				? securityManagers.securityManagerLR
				: securityManagers.securityManager2;
			const destSecurityManager = isLR
				? destSecurityManagerLR
				: destSecurityManager2;

			if (senderSecurityManager && destSecurityManager) {
				if (cc instanceof Security2CCNonceGet) {
					// Nonce Get -> all nonces are now invalid
					senderSecurityManager.deleteNonce(destNodeId);
					destSecurityManager.deleteNonce(mpdu.sourceNodeId);
				} else if (cc instanceof Security2CCNonceReport && cc.SOS) {
					// Nonce Report (SOS) -> We only know the receiver's nonce
					senderSecurityManager.setSPANState(destNodeId, {
						type: SPANState.LocalEI,
						receiverEI: cc.receiverEI!,
					});
					destSecurityManager.storeRemoteEI(
						mpdu.sourceNodeId,
						cc.receiverEI!,
					);
				} else if (cc instanceof Security2CCMessageEncapsulation) {
					const senderEI = cc.getSenderEI();
					if (senderEI) {
						// The receiver should now have a valid SPAN state, since decoding the S2 CC updates it.
						// The security manager for the sender however, does not. Therefore, update it manually,
						// if the receiver SPAN is indeed valid.

						const receiverSPANState = destSecurityManager
							.getSPANState(mpdu.sourceNodeId);
						if (receiverSPANState.type === SPANState.SPAN) {
							senderSecurityManager.setSPANState(
								destNodeId,
								receiverSPANState,
							);
						}
					}
				}
			}
		} else if (
			cc?.ccId === CommandClasses.Security
			&& cc instanceof SecurityCCNonceReport
		) {
			const senderSecurityManager =
				(await this.getSecurityManagers(mpdu.sourceNodeId))
					.securityManager;
			const destSecurityManager =
				(await this.getSecurityManagers(destNodeId))
					.securityManager;

			if (senderSecurityManager && destSecurityManager) {
				// Both nodes have a shared nonce now
				senderSecurityManager.setNonce(
					{
						issuer: mpdu.sourceNodeId,
						nonceId: senderSecurityManager.getNonceId(
							cc.nonce,
						),
					},
					{
						nonce: cc.nonce,
						receiver: destNodeId,
					},
					{ free: true },
				);

				destSecurityManager.setNonce(
					{
						issuer: mpdu.sourceNodeId,
						nonceId: senderSecurityManager.getNonceId(
							cc.nonce,
						),
					},
					{
						nonce: cc.nonce,
						receiver: destNodeId,
					},
					{ free: true },
				);
			}
		}

		return {
			internal: mpdu,
			cc,
			external: mpduToFrame(mpdu, cc),
		};
	}
}

function captureToZLFEntry(
	capture: CapturedData,
): Uint8Array {
	const buffer = new Bytes(14 + capture.rawData.length).fill(0);
	// Convert the date to a .NET datetime
	let ticks = BigInt(capture.timestamp.getTime()) * 10000n
		+ 621355968000000000n;
	// https://github.com/dotnet/runtime/blob/179473d3c8a1012b036ad732d02804b062923e8d/src/libraries/System.Private.CoreLib/src/System/DateTime.cs#L161
	ticks = ticks | (2n << 62n); // DateTimeKind.Local << KindShift

	buffer.writeBigUInt64LE(ticks, 0);
	const direction = 0b0000_0000; // inbound, outbound would be 0b1000_0000

	buffer[8] = direction | 0x01; // dir + session ID
	buffer[9] = capture.rawData.length;
	// bytes 10-12 are empty
	buffer.set(capture.rawData, 13);
	buffer[buffer.length - 1] = 0xfe; // end of frame
	return buffer;
}

function parseZLFHeader(buffer: Uint8Array): {
	znifferVersion: number;
	checksum: number;
	bytesRead: number;
} {
	if (buffer.length < 2048) {
		throw new ZWaveError(
			"Invalid ZLF file: header too small",
			ZWaveErrorCodes.Argument_Invalid,
		);
	}

	const bytes = Bytes.view(buffer);

	const znifferVersion = bytes[0];
	const checksum = bytes.readUInt16BE(2046);

	return {
		znifferVersion,
		checksum,
		bytesRead: 2048,
	};
}

type ParseZLFEntryResult =
	| (
		& {
			complete: true;
			bytesRead: number;
			accumulator?: undefined;
		}
		& (
			| {
				type: ZnifferMessageType.Data;
				msg: ZnifferDataMessage;
				entry: CapturedData;
			}
			| {
				type: ZnifferMessageType.Command;
				msg: ZnifferMessage;
				entry: CapturedData;
			}
			| {
				type?: undefined;
				msg?: undefined;
				entry?: undefined;
			}
		)
	)
	| ({
		complete: false;
		bytesRead: number;
		accumulator: CapturedData;
		type?: undefined;
		msg?: undefined;
		entry?: undefined;
	});

/** @internal */
export function parseZLFEntry(
	buffer: Uint8Array,
	offset: number,
	accumulator?: CapturedData,
): ParseZLFEntryResult {
	const bytes = Bytes.view(buffer.subarray(offset));

	// Each ZLF entry has a 14-byte overhead, so the buffer must have at least that size
	if (bytes.length < 14) {
		throw new ZWaveError(
			"Invalid ZLF file: entry truncated",
			ZWaveErrorCodes.PacketFormat_Truncated,
		);
	}

	// Parse .NET DateTime ticks (8 bytes, little-endian)
	const ticks = bytes.readBigUInt64LE(0);
	// Kind: 1 = UTC, 2 = Local
	// const dateTimeKind = Number((ticks >> 62n) & 0b11n);
	const timeStampMask = (1n << 62n) - 1n;
	const jsTimestamp = Number(
		((ticks & timeStampMask) - 621355968000000000n) / 10000n,
	);
	// FIXME: dateTimeKind should always be local. Properly support UTC
	const timestamp = new Date(jsTimestamp);

	// Ignore the direction and session ID byte
	const rawDataLength = bytes[9];
	const totalLength = 14 + rawDataLength;
	if (bytes.length < totalLength) {
		throw new ZWaveError(
			"Invalid ZLF file: entry truncated",
			ZWaveErrorCodes.PacketFormat_Truncated,
		);
	}
	const eod = bytes[totalLength - 1];
	// 0xfe designates a Zniffer entry
	if (eod !== 0xfe) {
		// Skip unsupported entries
		return {
			complete: true,
			bytesRead: totalLength,
		};
	}
	// bytes 10-12 are empty

	let rawData = bytes.subarray(13, totalLength - 1);
	if (accumulator) {
		rawData = Bytes.concat([
			accumulator.rawData,
			rawData,
		]);
	}

	try {
		const msg = ZnifferMessage.parse(rawData);

		const entry: CapturedData = {
			timestamp,
			rawData,
			frameData: msg.payload,
		};

		// Help TypeScript out a bit
		if (msg instanceof ZnifferDataMessage) {
			return {
				complete: true,
				bytesRead: totalLength,
				type: ZnifferMessageType.Data,
				msg,
				entry,
			};
		} else {
			// We are dealing with a command frame
			return {
				complete: true,
				bytesRead: totalLength,
				type: ZnifferMessageType.Command,
				msg,
				entry,
			};
		}
	} catch (e) {
		if (
			isZWaveError(e) && e.code === ZWaveErrorCodes.PacketFormat_Truncated
		) {
			// We are dealing with an incomplete frame, so we need to accumulate the data for the next iteration
			accumulator ??= {
				timestamp,
				rawData: new Bytes(),
				frameData: new Bytes(), // Cannot be determined yet
			};
			accumulator.rawData = rawData; // rawData is already concatenated

			return {
				complete: false,
				bytesRead: totalLength,
				accumulator,
			};
		}

		throw e;
	}
}
