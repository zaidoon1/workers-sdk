import { existsSync } from "node:fs";
import { loadAndParseConfig } from "@cloudflare/config";
import { formatZodError } from "@cloudflare/workers-utils";
import { loadDevVars, loadEnv } from "@cloudflare/workers-utils/local-env";
import { resolveLocalBindings } from "./local-env";
import { getRemoteBindings } from "./remote-bindings";
import type {
	ParsedInputConfig,
	ParsedInputWorkerConfig,
} from "@cloudflare/config";
import type { Binding } from "@cloudflare/workers-utils";
import type { WorkerOptions } from "miniflare";

export const NEW_CONFIG_FILENAME = "cloudflare.config.ts";

export interface LoadedNewConfig {
	settings: Pick<ParsedInputConfig, "accountId" | "complianceRegion">;
	worker: ParsedInputWorkerConfig;
	/** The Worker's bindings, with secrets and Hyperdrive resolved locally. */
	env: NonNullable<WorkerOptions["config"]["env"]>;
	/** The Worker's bindings in the shape remote proxy sessions expect. */
	remoteBindings: Record<string, Binding>;
}

/**
 * Load a `cloudflare.config.ts` in the shape Miniflare's native
 * `WorkerOptions.config` accepts, without converting it to a Wrangler config.
 *
 * Mirrors `@cloudflare/vite-plugin`: load and parse via `@cloudflare/config`,
 * then resolve secrets from `.env`/`.dev.vars` files in Vite's `envDir`.
 *
 * @param configPath Absolute path to the `cloudflare.config.ts` file.
 * @param mode The Vite mode, passed to config functions as `ctx.mode` and used
 * to select mode-specific `.env`/`.dev.vars` files.
 * @param envDir Vite's resolved `envDir`, or `false` to load no files.
 * @param remoteBindings Whether remote bindings are enabled.
 * @returns The parsed config and its locally resolved bindings.
 */
export async function loadNewConfig(
	configPath: string,
	mode: string | undefined,
	envDir: string | false,
	remoteBindings?: boolean
): Promise<LoadedNewConfig> {
	if (!existsSync(configPath)) {
		throw new TypeError(
			`\`experimental.newConfig\` is enabled but no \`${NEW_CONFIG_FILENAME}\` was found at ${configPath}.`
		);
	}

	const { result } = await loadAndParseConfig(configPath, {
		isPreview: false,
		mode,
	});

	if (!result.success) {
		throw new TypeError(
			`Invalid \`${NEW_CONFIG_FILENAME}\`:\n${formatZodError(result.error)}`
		);
	}

	const worker = result.data.worker;

	if (worker === undefined) {
		throw new TypeError(
			`\`${NEW_CONFIG_FILENAME}\` must define a Worker using the \`worker\` property.`
		);
	}

	const [localEnv, devVars] = await Promise.all([
		loadEnv(envDir, mode),
		loadDevVars(envDir, mode),
	]);
	// TODO: Replace this process-global compatibility bridge by explicitly
	// passing typed Cloudflare tool settings to the services that consume them.
	Object.assign(
		process.env,
		Object.fromEntries(
			Object.entries(localEnv.values).filter(([name]) =>
				name.startsWith("CLOUDFLARE_")
			)
		)
	);
	const { bindings, missingSecrets } = resolveLocalBindings(
		worker.env,
		localEnv.values,
		devVars,
		remoteBindings
	);

	if (missingSecrets.length > 0) {
		console.warn(
			`Missing required secrets: ${missingSecrets.join(", ")}. ` +
				(envDir === false
					? "Set them as environment variables."
					: `Add them to \`.dev.vars\` or \`.env\` in ${envDir}, or set them as environment variables.`)
		);
	}

	return {
		settings: {
			accountId: result.data.accountId,
			complianceRegion: result.data.complianceRegion,
		},
		worker,
		env: bindings,
		remoteBindings: getRemoteBindings(worker),
	};
}
