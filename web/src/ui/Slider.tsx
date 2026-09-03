/** Step scrubber. Native range input: keyboard, touch and screen readers for free (ponytail: zag slider
 * kept re-rendering under a controlled array value; the platform control needs no state machine). */
export default function Slider({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return <input type="range" aria-label={label} min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-amber-500" />;
}
