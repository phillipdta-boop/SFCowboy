// Copado's "Objects & Child Components" bundles the object-adjacent metadata types that are
// almost always deployed together, so users don't have to hunt for each one individually.
export const OBJECTS_AND_CHILD_COMPONENTS = "Objects & Child Components";

export const OBJECTS_AND_CHILD_COMPONENTS_TYPES = [
  "CustomObject",
  "CustomField",
  "ValidationRule",
  "RecordType",
  "WebLink",
  "BusinessProcess",
  "FieldSet",
  "CompactLayout",
];

export function expandTypeSelection(selected: Iterable<string>): string[] {
  const result = new Set<string>();
  for (const type of selected) {
    if (type === OBJECTS_AND_CHILD_COMPONENTS) {
      for (const t of OBJECTS_AND_CHILD_COMPONENTS_TYPES) result.add(t);
    } else {
      result.add(type);
    }
  }
  return Array.from(result);
}
