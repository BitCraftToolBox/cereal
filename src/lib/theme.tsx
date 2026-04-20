import {Accessor, createContext, createSignal, onMount, ParentComponent, useContext} from "solid-js";

type ThemeContextType = {
    isDark: Accessor<boolean>;
    toggle: () => void;
};

const ThemeContext = createContext<ThemeContextType>();

export const ThemeProvider: ParentComponent = (props) => {
    // Always start with false to avoid SSR/client hydration mismatch.
    // Actual preference is applied on mount (client-only).
    const [isDark, setIsDark] = createSignal(false);

    onMount(() => {
        const stored = localStorage.getItem("theme");
        const prefersDark =
            stored === "dark" ||
            (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
        setIsDark(prefersDark);
        document.documentElement.classList.toggle("dark", prefersDark);
    });

    const toggle = () => {
        setIsDark((prev) => {
            const next = !prev;
            localStorage.setItem("theme", next ? "dark" : "light");
            document.documentElement.classList.toggle("dark", next);
            return next;
        });
    };


    return (
        <ThemeContext.Provider value={{isDark, toggle}}>
            {props.children}
        </ThemeContext.Provider>
    );
};

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
    return ctx;
}
