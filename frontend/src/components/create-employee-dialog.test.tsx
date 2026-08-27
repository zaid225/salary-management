import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateEmployeeDialog } from "./create-employee-dialog";

const mutateAsync = vi.fn();

vi.mock("@/hooks/queries", () => ({
  useCreateEmployee: () => ({ mutateAsync, isPending: false }),
}));

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateEmployeeDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mutateAsync.mockReset();
});

describe("CreateEmployeeDialog", () => {
  it("blocks submit and shows the schema's own message for a malformed employee number", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Employee number"), "nope");
    await user.click(screen.getByRole("button", { name: /create employee/i }));

    // This is the exact message from CreateEmployeeSchema in the Worker -
    // the frontend never re-declares the rule (design spec §6), so this
    // assertion and the backend's 400 test are checking one source.
    expect(await screen.findByText(/Employee number must match/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("rejects a negative salary", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Amount"), "-500");
    await user.click(screen.getByRole("button", { name: /create employee/i }));

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("submits once every field satisfies the shared schema", async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValue({ employee: { id: "e1" } });
    renderDialog();

    await user.type(screen.getByLabelText("First name"), "Grace");
    await user.type(screen.getByLabelText("Last name"), "Hopper");
    await user.type(screen.getByLabelText("Email"), "grace@example.com");
    await user.type(screen.getByLabelText("Employee number"), "EMP-1000");
    await user.type(screen.getByLabelText("Hire date"), "2024-01-01");
    await user.type(screen.getByLabelText("Department"), "Engineering");
    await user.type(screen.getByLabelText("Job title"), "Engineer");
    await user.type(screen.getByLabelText("Level"), "L4");
    await user.type(screen.getByLabelText("Country"), "US");
    await user.type(screen.getByLabelText("Amount"), "120000");
    await user.type(screen.getByLabelText("Currency"), "USD");
    await user.type(screen.getByLabelText("Effective date"), "2024-01-01");

    await user.click(screen.getByRole("button", { name: /create employee/i }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      employeeNumber: "EMP-1000",
      email: "grace@example.com",
      salary: { currency: "USD" },
    });
  });
});
