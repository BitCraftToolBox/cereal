type FilterToggleProps = {
    label: string;
    checked: boolean;
    onChange: () => void;
    title?: string;
};

export function FilterToggle(props: FilterToggleProps) {
    return (
        <label
            class="flex items-center gap-1.5 cursor-pointer select-none text-sm text-text-muted hover:text-text transition-colors"
            title={props.title}
        >
            <input
                type="checkbox"
                checked={props.checked}
                onChange={props.onChange}
                class="w-3.5 h-3.5 accent-primary"
            />
            {props.label}
        </label>
    );
}
