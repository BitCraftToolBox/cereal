import {createContext, createSignal, ParentComponent, useContext} from "solid-js";
import {DataScopeContext} from "~/lib/data";

export interface NavEntry {
    path: string;
    label: string;
    versionTag?: string;
}

interface NavHistoryStore {
    history: () => NavEntry[];
    push: (entry: NavEntry) => void;
    updateTop: (label?: string, path?: string, versionTag?: string) => void;
}

const NavHistoryContext = createContext<NavHistoryStore>();

export const NavHistoryProvider: ParentComponent = (props) => {
    const scope = useContext(DataScopeContext);
    const [history, setHistory] = createSignal<NavEntry[]>([]);

    const push = (entry: NavEntry) => {
        if (entry.path === "/") {
            setHistory([]);
            return;
        }

        let tag = entry.versionTag ?? scope?.tag();
        if (entry.path.startsWith("/versions")) {
            tag = scope?.versions()?.[0]?.tag;
        }
        const enriched: NavEntry = {path: entry.path, label: entry.label, versionTag: tag};

        setHistory((prev) => {
            const existingIdx = prev.findIndex((e) => e.path === enriched.path && e.versionTag === enriched.versionTag);
            if (existingIdx !== -1) {
                return [...prev.slice(0, existingIdx), enriched];
            }
            return [...prev, enriched];
        });
    };

    const updateTop = (label?: string, path?: string, versionTag?: string) => {
        if (label === undefined && path === undefined && versionTag === undefined) return;
        setHistory((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const top = updated[updated.length - 1];
            if (top.path.startsWith("/versions") && (!path || path.startsWith("/versions"))) {
                versionTag = top.versionTag; // discard version changes on version pages
            }
            updated[updated.length - 1] = {
                path: path ?? top.path,
                label: label ?? top.label,
                versionTag: versionTag ?? top.versionTag
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
