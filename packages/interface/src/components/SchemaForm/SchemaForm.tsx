/**
 * Phase D2 — SchemaForm.
 *
 * Renders a JSON Schema as an HTML form. Plugin authors who write a tool's
 * argsSchema get a working form for free, and the same schema is what AI
 * tool-calls validate against — one source of truth, both pipelines.
 *
 * Coverage (07-INTERFACE-EXPOSURE.md §4):
 *   string  → <input type=text> (with `format: 'multiline'` → <textarea>)
 *   number/integer → <input type=number>
 *   boolean → <input type=checkbox>
 *   enum    → <select>
 *   array   → repeatable list with add/remove buttons
 *   object  → nested fieldset
 *   x-fx-readonly / x-fx-secret / x-fx-multiline custom keywords
 *
 * Validation is intentionally light (required + type) — the server's
 * Zod-derived ToolCall schema is the authoritative gate.
 */
import { useState, useCallback, useMemo } from 'react';
import type { ReactElement } from 'react';
import { defaultFor, findMissingRequired, coerceEnumValue, type JsonSchema } from './schema-form-utils';
import { useTranslation } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import './SchemaForm.css';

export type { JsonSchema } from './schema-form-utils';
export { findMissingRequired } from './schema-form-utils';

export interface SchemaFormProps {
  schema: JsonSchema;
  initialValue?: unknown;
  onSubmit: (value: unknown) => void;
  onCancel?: () => void;
  /** Override the default "Run" label on the submit button. */
  submitLabel?: string;
  layout?: 'inline' | 'panel';
  /** Disable the submit button (e.g. while a previous run is in flight). */
  busy?: boolean;
}

interface FieldProps {
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  required?: boolean;
  pathLabel?: string;
}

function Field({ schema, value, onChange, required, pathLabel }: FieldProps): ReactElement {
  const { t } = useTranslation();
  const readonly = schema['x-fx-readonly'] === true;
  const secret = schema['x-fx-secret'] === true;
  const multiline = schema['x-fx-multiline'] === true || schema.format === 'multiline';
  const label = schema.title ?? pathLabel ?? '';

  if (schema.enum) {
    return (
      <div className="fx-sf-row">
        <span className="fx-sf-label">{label}{required ? ' *' : ''}</span>
        <Select
          disabled={readonly}
          value={String(value ?? '')}
          onValueChange={(v) => onChange(coerceEnumValue(schema.enum!, v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schema.enum.map((opt, i) => (
              <SelectItem key={i} value={String(opt)}>{String(opt)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {schema.description ? <span className="fx-sf-hint">{schema.description}</span> : null}
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <label className="fx-sf-row fx-sf-row-bool">
        <Checkbox
          disabled={readonly}
          checked={value === true}
          onCheckedChange={(c) => onChange(c === true)}
        />
        <span className="fx-sf-label">{label}{required ? ' *' : ''}</span>
        {schema.description ? <span className="fx-sf-hint">{schema.description}</span> : null}
      </label>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <label className="fx-sf-row">
        <span className="fx-sf-label">{label}{required ? ' *' : ''}</span>
        <Input
          type="number"
          disabled={readonly}
          step={schema.type === 'integer' ? 1 : 'any'}
          min={schema.minimum}
          max={schema.maximum}
          value={value === '' || value == null ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') onChange(undefined);
            else {
              const n = schema.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
              onChange(Number.isFinite(n) ? n : undefined);
            }
          }}
        />
        {schema.description ? <span className="fx-sf-hint">{schema.description}</span> : null}
      </label>
    );
  }

  if (schema.type === 'array') {
    const arr = Array.isArray(value) ? value : [];
    const item = schema.items ?? { type: 'string' };
    return (
      <fieldset className="fx-sf-array">
        <legend>{label}{required ? ' *' : ''}</legend>
        {schema.description ? <div className="fx-sf-hint">{schema.description}</div> : null}
        {arr.map((v, i) => (
          <div className="fx-sf-array-row" key={i}>
            <Field
              schema={item}
              value={v}
              onChange={(next) => {
                const copy = [...arr];
                copy[i] = next;
                onChange(copy);
              }}
              pathLabel={`#${i}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="fx-sf-array-rm h-7 w-7 shrink-0"
              onClick={() => onChange(arr.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="fx-sf-array-add self-start"
          onClick={() => onChange([...arr, defaultFor(item)])}
        >
          {t('schemaForm.addItem')}
        </Button>
      </fieldset>
    );
  }

  if (schema.type === 'object') {
    const obj = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
    return (
      <fieldset className="fx-sf-object">
        {label ? <legend>{label}{required ? ' *' : ''}</legend> : null}
        {schema.description ? <div className="fx-sf-hint">{schema.description}</div> : null}
        {Object.entries(schema.properties ?? {}).map(([k, sub]) => (
          <Field
            key={k}
            schema={sub}
            value={obj[k]}
            required={schema.required?.includes(k)}
            pathLabel={k}
            onChange={(next) => onChange({ ...obj, [k]: next })}
          />
        ))}
      </fieldset>
    );
  }

  // string fallback (default)
  if (multiline) {
    return (
      <label className="fx-sf-row">
        <span className="fx-sf-label">{label}{required ? ' *' : ''}</span>
        <Textarea
          className="fx-sf-textarea"
          disabled={readonly}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
        />
        {schema.description ? <span className="fx-sf-hint">{schema.description}</span> : null}
      </label>
    );
  }
  return (
    <label className="fx-sf-row">
      <span className="fx-sf-label">{label}{required ? ' *' : ''}</span>
      <Input
        type={secret ? 'password' : 'text'}
        disabled={readonly}
        value={typeof value === 'string' ? value : ''}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {schema.description ? <span className="fx-sf-hint">{schema.description}</span> : null}
    </label>
  );
}

export function SchemaForm({
  schema,
  initialValue,
  onSubmit,
  onCancel,
  submitLabel,
  layout = 'panel',
  busy,
}: SchemaFormProps): ReactElement {
  const { t } = useTranslation();
  const initial = useMemo(
    () => (initialValue !== undefined ? initialValue : defaultFor(schema)),
    [initialValue, schema],
  );
  const [value, setValue] = useState<unknown>(initial);
  const [missing, setMissing] = useState<string[]>([]);

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const m = findMissingRequired(schema, value);
      setMissing(m);
      if (m.length === 0) onSubmit(value);
    },
    [schema, value, onSubmit],
  );

  return (
    <form className={`fx-sf fx-sf-${layout}`} onSubmit={submit}>
      <Field schema={schema} value={value} onChange={setValue} />
      {missing.length > 0 ? (
        <div className="fx-sf-error">{t('schemaForm.missingRequired', { fields: missing.join(', ') })}</div>
      ) : null}
      <div className="fx-sf-actions">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={busy}>
          {submitLabel ?? t('schemaForm.run')}
        </Button>
      </div>
    </form>
  );
}
