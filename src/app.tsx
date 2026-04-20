import {MetaProvider, Title} from "@solidjs/meta";
import {Router} from "@solidjs/router";
import {FileRoutes} from "@solidjs/start/router";
import {Suspense} from "solid-js";
import "./app.css";
import {Navbar} from "~/components/Navbar";
import {Breadcrumb} from "~/components/Breadcrumb";
import {Footer} from "~/components/Footer";
import {ThemeProvider} from "~/lib/theme";
import {DataProvider} from "~/lib/data";
import {NavHistoryProvider} from "~/lib/navHistory";
import {PageLoader} from "~/components/LoadingSpinner";
import {AppErrorBoundary} from "~/components/AppErrorBoundary";

export default function App() {
    return (
        <Router
            root={(props) => (
                <ThemeProvider>
                    <DataProvider>
                        <NavHistoryProvider>
                            <MetaProvider>
                                <Title>cereal — BitCraft Data Browser</Title>
                                <div class="min-h-screen flex flex-col bg-surface-0 text-text overflow-x-hidden">
                                    <Navbar/>
                                    <div class="px-4 py-2">
                                        <Breadcrumb/>
                                    </div>
                                    <main class="flex-1 flex flex-col px-4 pb-8">
                                        <AppErrorBoundary>
                                            <Suspense fallback={<PageLoader/>}>
                                                {props.children}
                                            </Suspense>
                                        </AppErrorBoundary>
                                    </main>
                                    <Footer/>
                                </div>
                            </MetaProvider>
                        </NavHistoryProvider>
                    </DataProvider>
                </ThemeProvider>
            )}
        >
            <FileRoutes/>
        </Router>
    );
}
