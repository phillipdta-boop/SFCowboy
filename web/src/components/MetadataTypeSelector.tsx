import { useState } from "react";

export interface MetadataTypeSelectorProps {
  types: string[];
  selected: Set<string>;
  onToggle: (type: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}

export function MetadataTypeSelector({ types, selected, onToggle, onSelectAll, onSelectNone }: MetadataTypeSelectorProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const options = types.filter((t) => !selected.has(t) && t.toLowerCase().includes(query.toLowerCase()));

  function pick(type: string) {
    onToggle(type);
    setQuery("");
  }

  return (
    <div>
      <div className="type-chips">
        {Array.from(selected).map((type) => (
          <span key={type} className="chip">
            {type}
            <button type="button" aria-label={`Remove ${type}`} onClick={() => onToggle(type)}>
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="combobox">
        <input
          role="combobox"
          aria-label="Metadata types"
          aria-expanded={open}
          aria-controls="metadata-type-options"
          placeholder="Select…"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        {open && options.length > 0 && (
          <ul id="metadata-type-options" role="listbox">
            {options.map((type) => (
              <li key={type}>
                {/* Selecting on mousedown (with preventDefault) rather than click means the
                    input never blurs first, so the dropdown doesn't close before the pick registers. */}
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(type);
                  }}
                >
                  {type}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div role="group" aria-label="Select metadata types">
        <button type="button" onClick={onSelectAll}>
          Select all
        </button>
        <button type="button" onClick={onSelectNone}>
          Select none
        </button>
      </div>
    </div>
  );
}
