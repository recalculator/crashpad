import { gitOut } from "../git.ts";
import { GitSource, type Source } from "../source.ts";
import type { Discoverer, Discovery } from "../suite/runner.ts";
import type { ConfigLayer } from "../suite/config.ts";
import { VERSION } from "../version.ts";
import { discoverNode, DISCOVERY_RULES_VERSION } from "./node.ts";
import { loadSettings, readDiscoveryCache, repoIdentity, writeDiscoveryCache } from "./store.ts";

export { DISCOVERY_RULES_VERSION };

async function treeOf(source: Source, projectDir: string): Promise<string | null> {
  if (!(source instanceof GitSource)) return null;
  const spec = projectDir === "." ? `${source.commit}^{tree}` : `${source.commit}:${projectDir}`;
  return gitOut(source.repo, ["rev-parse", "--verify", spec]).catch(() => null);
}

/**
 * The default discoverer. Results for a committed tree are cached in Crashpad's
 * storage under that exact tree id; working trees are always rediscovered.
 */
export function discoverer(opts: { cache?: boolean } = {}): Discoverer {
  return async (source: Source, projectDir: string): Promise<Discovery> => {
    const tree = opts.cache === false ? null : await treeOf(source, projectDir);
    const repoKey = tree && source instanceof GitSource ? (await repoIdentity(source.repo)).key : null;
    if (tree && repoKey) {
      const hit = await readDiscoveryCache<Discovery>(repoKey, tree, DISCOVERY_RULES_VERSION, VERSION).catch(() => null);
      if (hit) return hit;
    }
    const { node: _node, ...result } = await discoverNode(source, projectDir);
    if (tree && repoKey) await writeDiscoveryCache(repoKey, tree, DISCOVERY_RULES_VERSION, VERSION, result).catch(() => {});
    return result;
  };
}

/** Stored per-repository settings as a configuration layer, if any. */
export async function settingsFor(repoRoot: string): Promise<ConfigLayer | undefined> {
  const { key } = await repoIdentity(repoRoot);
  const s = await loadSettings(key);
  return s && Object.keys(s.config).length ? (s.config as ConfigLayer) : undefined;
}
