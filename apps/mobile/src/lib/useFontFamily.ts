import { Platform } from "react-native";
export function useFontFamily(_weight?: string) {
  return Platform.OS === "ios" ? "System" : "sans-serif";
}
