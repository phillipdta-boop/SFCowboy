import type { DiffItem } from "../api/client.js";

export function diffItemKey(item: { type: string; fullName: string }): string {
  return `${item.type}::${item.fullName}`;
}

export interface DiffTreeProps {
  items: DiffItem[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}

export function DiffTree({ items, selected, onToggle }: DiffTreeProps) {
  const byType = new Map<string, DiffItem[]>();
  for (const item of items) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type)!.push(item);
  }

  return (
    <div>
      {Array.from(byType.entries()).map(([type, typeItems]) => (
        <fieldset key={type}>
          <legend>{type}</legend>
          {typeItems.map((item) => {
            const key = diffItemKey(item);
            return (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => onToggle(key)}
                  disabled={item.status === "unchanged"}
                />
                {item.fullName} ({item.status})
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
