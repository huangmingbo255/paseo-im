import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load a node_modules package at runtime instead of letting the daemon's
 * server bundler inline it. Needed for SDKs whose code references bare
 * `__dirname` or `import.meta`: the daemon executes the CJS bundle inside a
 * plain function scope, where neither is defined.
 *
 * The specifier is only present as a runtime string, so the bundler keeps
 * this call opaque. Paseo evaluates the bundle inside its own app process, so
 * `process.argv[1]` points at Paseo rather than the plugin. Resolve the
 * configured plugin directory first, then retain the standalone fallback.
 */
function pluginRequire(): NodeJS.Require {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  try {
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const pluginPath = config.plugins?.["paseo-im"]?.path;
    if (typeof pluginPath === "string" && isAbsolute(pluginPath)) {
      return createRequire(join(pluginPath, "package.json"));
    }
  } catch {
    // Keep local development and older standalone daemons working.
  }

  const entry = process.argv[1];
  const base = entry && isAbsolute(entry) ? dirname(entry) : process.cwd();
  return createRequire(join(base, "package.json"));
}

export async function loadPackage<T = Record<string, unknown>>(name: string): Promise<T> {
  const entry = pluginRequire().resolve(name);
  return (await import(pathToFileURL(entry).href)) as T;
}
