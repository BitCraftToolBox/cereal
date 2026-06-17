import {Accessor, createContext, createSignal, ParentComponent, Setter, useContext} from "solid-js";

interface HomeState {
    search: Accessor<string>;
    setSearch: Setter<string>;
    showStatic: Accessor<boolean>;
    setShowStatic: Setter<boolean>;
    showPrivate: Accessor<boolean>;
    setShowPrivate: Setter<boolean>;
    showNonStatic: Accessor<boolean>;
    setShowNonStatic: Setter<boolean>;
}

const HomeStateContext = createContext<HomeState>();

export const HomeStateProvider: ParentComponent = (props) => {
    const [search, setSearch] = createSignal("");
    const [showStatic, setShowStatic] = createSignal(true);
    const [showPrivate, setShowPrivate] = createSignal(false);
    const [showNonStatic, setShowNonStatic] = createSignal(false);

    return (
        <HomeStateContext.Provider
            value={{
                search,
                setSearch,
                showStatic,
                setShowStatic,
                showPrivate,
                setShowPrivate,
                showNonStatic,
                setShowNonStatic,
            }}
        >
            {props.children}
        </HomeStateContext.Provider>
    );
};

export function useHomeState() {
    const ctx = useContext(HomeStateContext);
    if (!ctx) throw new Error("useHomeState must be used within HomeStateProvider");
    return ctx;
}

