import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ClerkProvider } from "@clerk/clerk-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import App from "./App";
import { OrgProvider } from "./lib/org-context";
import { MissingClerkKey } from "./components/missing-clerk-key";
import "./styles/globals.css";

const PUBLISHABLE_KEY: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root")!);

// Without a key, ClerkProvider throws on mount and the whole app is a blank
// screen with a console error. A named setup screen is a far better failure
// mode for someone cloning this repo (env-vars.md's degrade-cleanly rule,
// applied to the frontend).
root.render(
  <React.StrictMode>
    {PUBLISHABLE_KEY ? (
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/sign-in">
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <OrgProvider>
              <App />
              <Toaster richColors closeButton />
            </OrgProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ClerkProvider>
    ) : (
      <MissingClerkKey />
    )}
  </React.StrictMode>,
);
