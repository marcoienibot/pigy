import type { Network, SandboxFaults } from "@pigy/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { EmptyState } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  ApiError,
  armSandboxFault,
  disarmSandboxFaults,
  fetchSandboxFaults,
} from "@/lib/api";
import { selectChannels } from "@/lib/channels";
import { checkSignedOut, failureMessage, useFetched } from "@/lib/fetched";
import { listedNetworks, networkInfo } from "@/lib/networks";
import { useOnline } from "@/lib/online";
import {
  faultKind,
  faultOperation,
  firstNetwork,
  offeredOperations,
  waitingKinds,
  waitNote,
} from "@/lib/simulator";
import { useSynced } from "@/sync/react";

export const Route = createFileRoute("/_app/simulator/failures")({
  component: Failures,
});

/**
 * The failure panel: makes the next request to a simulated network fail,
 * so that the person sees what pigy does about it, and lists what is
 * armed. The faults are the world's and not synced: the panel asks the
 * server for them, and changes them with a request.
 */
function Failures() {
  const {
    data: faults,
    failure,
    loading,
    refresh,
    replace,
  } = useFetched(fetchSandboxFaults);
  // The connection is back: a panel that could not be loaded tries again.
  useOnline(() => {
    if (!faults) refresh();
  });

  if (!faults) {
    return failure && !loading ? (
      <EmptyState
        title="The failure panel could not be loaded"
        description={failureMessage(failure)}
      >
        <Button variant="outline" onClick={refresh}>
          Try again
        </Button>
      </EmptyState>
    ) : (
      <p role="status" className="py-16 text-center text-muted-foreground">
        Loading the failure panel…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ArmForm faults={faults} onArmed={replace} />
      <Armed faults={faults} onDisarmed={replace} />
    </div>
  );
}

/** What the form says after the person has done something. */
type Said = { tone: "good" | "bad"; text: string; field?: string };

function ArmForm({
  faults,
  onArmed,
}: {
  faults: SandboxFaults;
  onArmed: (faults: SandboxFaults) => void;
}) {
  const id = useId();
  const channels = useSynced(selectChannels);
  // In the order in which the app lists the networks everywhere else.
  const declared = listedNetworks.filter((name) =>
    faults.networks.some(({ network }) => network === name),
  );
  const [network, setNetwork] = useState<Network | undefined>(() =>
    firstNetwork(
      declared,
      channels.map((channel) => channel.network),
    ),
  );
  const offered = faults.networks.find(
    (candidate) => candidate.network === network,
  );
  const kinds = offered?.kinds ?? [];
  const operations = offeredOperations(offered?.operations ?? []);
  const [kind, setKind] = useState(kinds[0]);
  // "" for any request. Posting where the network has it: the panel is
  // there to make the next publish fail.
  const [operation, setOperation] = useState(operations[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const choose = (next: Network) => {
    setNetwork(next);
    const of = faults.networks.find((candidate) => candidate.network === next);
    // What the other network has may not be the network's to have.
    if (!of?.kinds.includes(kind ?? "")) setKind(of?.kinds[0]);
    if (operation !== "" && !of?.operations.includes(operation)) {
      setOperation(offeredOperations(of?.operations ?? [])[0] ?? "");
    }
    setSaid(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!network || !kind) return;
    setBusy(true);
    setSaid(null);
    try {
      onArmed(
        await armSandboxFault({
          network,
          kind,
          ...(operation !== "" && { operation }),
        }),
      );
      setSaid({
        tone: "good",
        text: `Armed: ${faultKind(kind).label}, on ${networkInfo[network].label}, for ${faultOperation(operation === "" ? null : operation).toLowerCase()}.`,
      });
    } catch (error) {
      checkSignedOut(error);
      setSaid({
        tone: "bad",
        text: failureMessage(error),
        ...(error instanceof ApiError &&
          error.field !== undefined && { field: error.field }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div>
        <h2 id={`${id}-heading`} className="font-medium">
          Make the next request fail
        </h2>
        <p className="mt-1 text-muted-foreground">
          A fault strikes once: the next request of its kind to the network
          fails that way, and then the network works again. Arm one, then
          publish a post to see what pigy does about it.
        </p>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-medium">Network</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {declared.map((name) => (
            <label key={name} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-network`}
                value={name}
                checked={network === name}
                onChange={() => choose(name)}
                className="size-4 accent-primary"
              />
              {networkInfo[name].label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 font-medium">What goes wrong</legend>
        {kinds.map((name) => {
          const words = faultKind(name);
          return (
            <div key={name} className="flex items-start gap-2">
              <input
                type="radio"
                id={`${id}-kind-${name}`}
                name={`${id}-kind`}
                value={name}
                checked={kind === name}
                onChange={() => {
                  setKind(name);
                  setSaid(null);
                }}
                aria-describedby={`${id}-about-${name}`}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <div className="min-w-0">
                <label htmlFor={`${id}-kind-${name}`} className="block">
                  {words.label}
                </label>
                <p
                  id={`${id}-about-${name}`}
                  className="text-xs text-muted-foreground"
                >
                  {words.description}
                </p>
              </div>
            </div>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-operation`} className="font-medium">
          Which request
        </label>
        <NativeSelect
          id={`${id}-operation`}
          value={operation}
          onChange={(event) => {
            setOperation(event.target.value);
            setSaid(null);
          }}
          className="w-full sm:w-72"
        >
          {operations.map((name) => (
            <NativeSelectOption key={name} value={name}>
              {faultOperation(name)}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="">Any request</NativeSelectOption>
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          Publishing a post asks the network more than once: it reads the
          account before it posts. Any request strikes the first of them.
        </p>
      </div>

      {kind && waitingKinds.has(kind) && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-300">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          {waitNote}
        </p>
      )}

      {said && (
        <p
          role={said.tone === "bad" ? "alert" : "status"}
          className={
            said.tone === "bad" ? "text-destructive" : "text-muted-foreground"
          }
        >
          {said.text}
          {said.tone === "good" && (
            <>
              {" "}
              <Link
                to="/"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Write a post
              </Link>
            </>
          )}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={busy || !network || !kind}>
          {busy ? "Arming…" : "Arm"}
        </Button>
      </div>
    </form>
  );
}

function Armed({
  faults,
  onDisarmed,
}: {
  faults: SandboxFaults;
  onDisarmed: (faults: SandboxFaults) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const armed = faults.networks.flatMap(({ network, armed }) =>
    armed.map((fault, index) => ({ network, index, ...fault })),
  );

  const disarm = async () => {
    setBusy(true);
    setFailure(null);
    try {
      onDisarmed(await disarmSandboxFaults());
    } catch (error) {
      checkSignedOut(error);
      setFailure(failureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={`${id}-heading`} className="flex-1 font-medium">
          Armed
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || armed.length === 0}
          onClick={disarm}
        >
          Disarm all
        </Button>
      </div>
      {failure && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
      {armed.length === 0 ? (
        <p className="text-muted-foreground">
          Nothing is armed: the simulated networks work as they should.
        </p>
      ) : (
        <ol aria-label="Armed faults" className="divide-y rounded-lg border">
          {armed.map(({ network, index, kind, operation }) => (
            <li
              key={`${network}-${index}`}
              className="flex flex-wrap items-baseline gap-x-2 px-3 py-2"
            >
              <span className="font-medium">{faultKind(kind).label}</span>
              <span className="text-muted-foreground">
                {networkInfo[network].label} ·{" "}
                {operation === null
                  ? "any request"
                  : faultOperation(operation).toLowerCase()}
              </span>
              {index === 0 && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Strikes next
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
