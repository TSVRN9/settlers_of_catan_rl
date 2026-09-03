import * as select from "@zag-js/select";
import { Portal, normalizeProps, useMachine } from "@zag-js/react";
import { useId, useMemo } from "react";

export interface Option { value: string; label: string }

export default function Select({ value, options, onChange, label }: { value: string; options: Option[]; onChange: (v: string) => void; label: string }) {
  const collection = useMemo(() => select.collection({ items: options, itemToString: (o) => o.label, itemToValue: (o) => o.value }), [options]);
  const service = useMachine(select.machine, { id: useId(), collection, value: [value], onValueChange: ({ value }) => value[0] && onChange(value[0]), positioning: { sameWidth: true } });
  const api = select.connect(service, normalizeProps);
  return (
    <div {...api.getRootProps()} className="w-full">
      <label {...api.getLabelProps()} className="label">{label}</label>
      <div {...api.getControlProps()}>
        <button {...api.getTriggerProps()} className="btn w-full justify-between">
          <span {...api.getValueTextProps()}>{api.valueAsString || "Select…"}</span>
          <span {...api.getIndicatorProps()}>▾</span>
        </button>
      </div>
      <Portal>
        <div {...api.getPositionerProps()} className="z-50">
          <ul {...api.getContentProps()} className="card p-1 outline-none">
            {options.map((o) => (
              <li key={o.value} {...api.getItemProps({ item: o })} className="cursor-pointer rounded px-2 py-1 text-sm data-highlighted:bg-amber-100 data-[state=checked]:font-semibold dark:data-highlighted:bg-amber-900/40">
                <span {...api.getItemTextProps({ item: o })}>{o.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </Portal>
    </div>
  );
}
