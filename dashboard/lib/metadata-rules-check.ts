// The engine's metadata rule checker, imported as-is so the editor's in-browser checks are the
// API's checks: one implementation, no copy to drift. Pure (zod + RegExp), safe in the browser.
export {
  checkValue,
  checkMetadataWrite,
  segmentsOf,
  resolvePath,
  MetadataRuleError,
  type RuleSpec,
} from "../../src/modules/metadata-rules/check";
