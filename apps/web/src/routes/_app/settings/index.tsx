import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { type Theme, themes, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  type Kept,
  keepOnDevice,
  readKept,
  useKept,
} from "@/lib/device-storage";
import { failureMessage, useFetched } from "@/lib/fetched";
import { isInstalled, isIos, useInstall } from "@/lib/install";
import {
  notificationWords,
  readNotifications,
  turnOffNotifications,
  turnOnNotifications,
} from "@/lib/notifications";
import { useReloadToUpdate, useUpdateOffer } from "@/lib/reload-to-update";

export const Route = createFileRoute("/_app/settings/")({
  // What the browser says about the data on this device is read before the
  // screen is drawn, so that its row is there from the first moment. That
  // asks the browser and not the server, and is over at once.
  loader: () => readKept(),
  component: General,
});

const themeLabels: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * pigy as an app on this device: installing it, loading a new version of
 * it, and whether the browser keeps its data. The last is always there to
 * say, and the screen has it when it is first drawn: see the loader. So
 * the section does not come and go. It is left out only where a browser
 * has not answered in time and nothing else is to be said.
 */
function App() {
  const install = useInstall();
  const update = useUpdateOffer();
  const { reloading, reload } = useReloadToUpdate();
  // Safari offers nothing that a button could start, so on an iPhone or
  // iPad the person is told where the browser has it.
  const explain = isIos && !isInstalled();
  const kept = useKept();

  return (
    <section className="mt-8">
      <h2 className="font-medium">App</h2>
      <div className="mt-3 divide-y rounded-lg border">
        {install && (
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <p>
              Install pigy
              <span className="block text-muted-foreground">
                It opens in a window of its own, also without a connection.
              </span>
            </p>
            <Button variant="outline" size="sm" onClick={install}>
              Install
            </Button>
          </div>
        )}
        {explain && (
          <p className="px-3 py-2">
            Install pigy
            <span className="block text-muted-foreground">
              Open the Share menu of the browser and choose “Add to Home
              Screen”. pigy then opens like an app, also without a connection.
            </span>
          </p>
        )}
        {update && (
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <p>
              A new version of pigy is ready
              <span className="block text-muted-foreground">
                It takes over the next time pigy is opened, or now.
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={reloading}
              onClick={reload}
            >
              Reload to update
            </Button>
          </div>
        )}
        {kept && <DeviceData kept={kept} />}
        <p className="px-3 py-2">
          Sharing to pigy
          <span className="block text-muted-foreground">
            On Android, once pigy is installed, other apps can share a text or a
            link to it: it opens as a new draft. Other systems do not offer that
            to an app like pigy.
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * The notifications of this device: whether pigy may show them here, and
 * the button that turns them on and off. What they tell of is in the inbox
 * whatever is set here.
 *
 * The browser is asked for its permission when the person presses "Turn
 * on", and at no other time: not when the app starts, and not when this
 * screen is shown. How things stand is asked of the browser and of the
 * server, which knows whether it sends to this device, so the row has a
 * moment in which it does not know, and says so when the server cannot be
 * reached.
 */
function Notifications() {
  const { data, failure, loading, refresh, change } =
    useFetched(readNotifications);
  // A change is on its way, and what came of the last one that the state
  // does not say.
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const turn = async (on: boolean) => {
    setChanging(true);
    setNote(null);
    try {
      await change(async () => {
        const result = await (on
          ? turnOnNotifications()
          : turnOffNotifications());
        if (result !== "dismissed") return result;
        setNote(
          "The browser has not been given your permission, so nothing was turned on.",
        );
        return "off";
      });
    } catch (error) {
      setNote(
        `Notifications could not be turned ${on ? "on" : "off"}. ${failureMessage(error)}`,
      );
    } finally {
      setChanging(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="font-medium">Notifications</h2>
      <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
        <p className="min-w-0">
          Notifications on this device
          <span className="block text-muted-foreground">
            {data
              ? notificationWords[data]
              : failure
                ? `pigy cannot tell how they stand. ${failureMessage(failure)}`
                : "Looking how they stand…"}
          </span>
          {note && (
            <span role="status" className="mt-1 block">
              {note}
            </span>
          )}
        </p>
        {(data === "on" || data === "off") && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={changing}
            onClick={() => void turn(data === "off")}
          >
            {data === "on" ? "Turn off" : "Turn on"}
          </Button>
        )}
        {!data && failure !== null && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={loading}
            onClick={refresh}
          >
            Try again
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Says whether the browser has promised to keep what pigy stores on this
 * device, and offers to ask it where it has not. The app asks by itself
 * with the first change after it is opened: the button is for a browser
 * that asks the person, who has not answered, and for one that decides by
 * itself and may decide otherwise by now.
 *
 * A browser that decides by itself says no without showing anything, and
 * the row is then as it was before the button was pressed. So the row
 * says that the browser was asked and has refused, and what makes it
 * decide otherwise: nothing here is broken, and nothing is left to press.
 */
function DeviceData({ kept }: { kept: Kept }) {
  const [refused, setRefused] = useState(false);
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <p>
        Data on this device
        <span className="block text-muted-foreground">
          {kept === "kept" &&
            "The browser has promised to keep what pigy stores here, changes that are not synced yet included."}
          {kept === "not-kept" &&
            "The browser may delete what pigy stores here when the device runs low on space. Changes that are not synced yet would be lost."}
          {kept === "unknown" &&
            "This browser does not say whether it keeps what pigy stores here. It may delete it when the device runs low on space."}
        </span>
        {kept === "not-kept" && refused && (
          <span role="status" className="mt-1 block">
            The browser was asked and has decided not to, for now. Some
            browsers, Chrome among them, decide this by themselves and ask
            nobody: they keep the data of an app that is installed, and of a
            site that is used a lot. There is nothing else to press.
          </span>
        )}
      </p>
      {kept === "not-kept" && (
        <Button
          variant="outline"
          size="sm"
          onClick={async () =>
            setRefused((await keepOnDevice()) === "not-kept")
          }
        >
          Ask to keep it
        </Button>
      )}
    </div>
  );
}

function General() {
  return (
    <>
      <Appearance />
      <Notifications />
      <App />
    </>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();

  return (
    <section>
      <h2 className="font-medium">Appearance</h2>
      <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
        <span id="theme-label">Theme</span>
        <ToggleGroup
          aria-labelledby="theme-label"
          variant="outline"
          size="sm"
          spacing={0}
          value={[theme]}
          onValueChange={([value]) => {
            // Pressing the active option clears the selection. Keep the
            // current theme in that case.
            const next = themes.find((option) => option === value);
            if (next) setTheme(next);
          }}
        >
          {themes.map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {themeLabels[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </section>
  );
}
