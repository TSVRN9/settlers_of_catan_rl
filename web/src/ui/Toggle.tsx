import * as toggle from "@zag-js/toggle-group";
import { normalizeProps, useMachine } from "@zag-js/react";
import { useId } from "react";

export default function Toggle({ value, options, onChange, label }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; label: string }) {
  const service = useMachine(toggle.machine, { id: useId(), value: [value], onValueChange: ({ value }) => value[0] && onChange(value[0]), deselectable: false });
  const api = toggle.connect(service, normalizeProps);
  return (
    <div {...api.getRootProps()} className="inline-flex overflow-hidden rounded-md border border-stone-300 dark:border-stone-700" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} {...api.getItemProps({ value: o.value })} className="px-2.5 py-1 text-sm data-[state=on]:bg-amber-500 data-[state=on]:text-stone-950 bg-white dark:bg-stone-800">{o.label}</button>
      ))}
    </div>
  );
}
