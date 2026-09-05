import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "expo-crypto";
import type { Api } from "./api";

export async function openDocument(api: Api, path: string, name: string) {
  const url = `${api.root}${path}`;
  if (Platform.OS === "web") {
    const response = await fetch(url, { headers: api.headers });
    if (!response.ok) throw new Error("Could not open this document.");
    const blob = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = blob;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(blob), 60_000);
  } else {
    const file = await File.downloadFileAsync(
      url,
      new File(
        Paths.cache,
        `${randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      ),
      { headers: api.headers },
    );
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri);
    else throw new Error("Document sharing is not available on this device.");
  }
}

export function linkCitations(text: string) {
  return text.replace(
    /\[([^\]\n]+?\.(?:pdf|md|markdown|txt))(?:,\s*p\.(\d+))?\](?!\()/gi,
    (_, name: string, page?: string) =>
      `[${name}${page ? `, p.${page}` : ""}](https://vivid-library.invalid/source?name=${encodeURIComponent(name)})`,
  );
}
