import {createContext, createSignal, ParentComponent, useContext} from "solid-js";

export interface NavEntry {
    path: string;
    label: string;
}

interface NavHistoryStore {
    history: () => NavEntry[];
    push: (entry: NavEntry) => void;
    /** Replace the label (and optionally path) for the current top entry */
    updateTop: (label: string, path?: string) => void;
}

const NavHistoryContext = createContext<NavHistoryStore>();

export const NavHistoryProvider: ParentComponent = (props) => {
    const [history, setHistory] = createSignal<NavEntry[]>([]);

    const push = (entry: NavEntry) => {
        if (entry.path === "/") {
            setHistory([]);
            return;
        }
        setHistory((prev) => {
            // If we're navigating to a path already in history, truncate back to it
            const existingIdx = prev.findIndex((e) => e.path === entry.path);
            if (existingIdx !== -1) {
                return [...prev.slice(0, existingIdx), entry];
            }
            return [...prev, entry];
        });
    };

    const updateTop = (label: string, path?: string) => {
        setHistory((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            updated[updated.length - 1] = {
                ...updated[updated.length - 1],
                label, ...(path !== undefined ? {path} : {})
            };
            return updated;
        });
    };

    return (
        <NavHistoryContext.Provider value={{history, push, updateTop}}>
            {props.children}
        </NavHistoryContext.Provider>
    );
};

export function useNavHistory() {
    const ctx = useContext(NavHistoryContext);
    if (!ctx) throw new Error("useNavHistory must be used within NavHistoryProvider");
    return ctx;
}
