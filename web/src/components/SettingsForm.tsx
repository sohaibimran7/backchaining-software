import type { SettingField } from '@shared/calc/types';

/** Renders any method's settings from its own field descriptions — no method-specific UI code anywhere. */
export function SettingsForm({ fields, value, onChange, disabled }: { fields: SettingField[]; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; disabled?: boolean }) {
  if (fields.length === 0) return <p className="muted small">This method has no settings.</p>;
  return (
    <div className="stack">
      {fields.map((f) => (
        <div key={f.key} className="field">
          {f.type === 'boolean' ? (
            <label className="check">
              <input type="checkbox" disabled={disabled} checked={!!value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: e.target.checked })} />
              <span>
                <strong>{f.label}</strong>
                <span className="muted small" style={{ display: 'block' }}>
                  {f.help}
                </span>
              </span>
            </label>
          ) : (
            <label className="field">
              <span>{f.label}</span>
              {f.type === 'select' ? (
                <select className="select" disabled={disabled} value={String(value[f.key] ?? '')} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="row">
                  <input
                    className="input"
                    style={{ maxWidth: 120 }}
                    type="number"
                    disabled={disabled}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={Number(value[f.key] ?? 0)}
                    onChange={(e) => onChange({ ...value, [f.key]: Number(e.target.value) })}
                  />
                  {f.unit && <span className="muted small">{f.unit}</span>}
                </div>
              )}
              <span className="muted small" style={{ fontWeight: 400 }}>
                {f.help}
              </span>
            </label>
          )}
        </div>
      ))}
    </div>
  );
}
