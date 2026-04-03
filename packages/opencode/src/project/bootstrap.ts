import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Snapshot } from "../snapshot"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"

export async function InstanceBootstrap() {
  const log = Log.create({ service: "startup" })
  log.info("bootstrapping", { directory: Instance.directory })
  const t1 = log.time("plugin")
  await Plugin.init()
  t1.stop()
  { using _ = log.time("share-next"); ShareNext.init() }
  { using _ = log.time("format"); Format.init() }
  const t2 = log.time("lsp")
  await LSP.init()
  t2.stop()
  { using _ = log.time("file"); File.init() }
  { using _ = log.time("file-watcher"); FileWatcher.init() }
  { using _ = log.time("vcs"); Vcs.init() }
  { using _ = log.time("snapshot"); Snapshot.init() }

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
