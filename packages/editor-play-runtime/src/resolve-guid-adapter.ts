// Thin pass-through adapter that reshapes a loadByGuid-flavoured Result into
// the {ok, value:{kind,guid}} | {ok:false, error} shape expected by
// resolveDefaultScene (engine-project/loader.ts). On success it extracts
// .kind from the asset payload and backfills the guid. On failure it returns
// the upstream error object unchanged (AssetError / ImageError / RhiError --
// no wrapping, no stripping, no field mutation).
//
// Design anchors (D-2 / C3): local function scope in main.ts; the unit test
// (w3/w4) imports this directly so it does not pull in the DOM-heavy main.ts
// top-level code.
export function createResolveGuidAdapter(
  loadByGuid: (guid: string) => Promise<
    | { ok: true; value: { kind: string } }
    | { ok: false; error: unknown }
  >,
): (guid: string) => Promise<
  | { ok: true; value: { kind: string; guid: string } }
  | { ok: false; error: unknown }
> {
  return async (guid: string) => {
    const result = await loadByGuid(guid);
    if (!result.ok) return result; // thin pass-through unchanged
    return { ok: true, value: { kind: result.value.kind, guid } };
  };
}