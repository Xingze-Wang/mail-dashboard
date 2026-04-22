"use client";

interface Option<T extends string> {
  key: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: readonly Option<T>[];
}

export function SegmentedControl<T extends string>({ value, onChange, options }: Props<T>) {
  return (
    <div className="status-tabs">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`status-tab ${value === o.key ? "active" : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
