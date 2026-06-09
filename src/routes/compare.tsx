import type {RouteSectionProps} from "@solidjs/router";
import {CompareScopeProvider} from "~/lib/data";

/** Layout for all /compare routes — provides the dual-version compare scope. */
export default function CompareLayout(props: RouteSectionProps) {
    return <CompareScopeProvider>{props.children}</CompareScopeProvider>;
}
