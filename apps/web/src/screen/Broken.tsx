import { Button } from '../ui/button'
import { Face } from '../ui/Face'
import { useAgain } from '../ui/Recover'

/**
 * What is shown when the app itself failed to draw. Nothing is lost by it: Threads, drafts and
 * everything Vivid is doing live on the server and on this device, so the two ways on are to draw
 * the screen again, which is enough when the failure was one bad moment, and to load Vivid afresh.
 */
export function Broken() {
  const again = useAgain()
  return (
    <main className="flex size-full flex-col items-center justify-center gap-3 bg-surface-1 px-8 text-center">
      <Face size={40} mood="neutral" />
      <h1 className="text-title font-title text-ink">This screen could not be shown</h1>
      <p className="max-w-xs text-label text-pretty text-ink-3">
        Something went wrong while drawing it. Your threads and what you were writing are safe.
      </p>
      <div className="mt-1 flex gap-2">
        <Button variant="outline" onClick={again}>
          Try again
        </Button>
        <Button onClick={() => location.reload()}>Reload Vivid</Button>
      </div>
    </main>
  )
}
