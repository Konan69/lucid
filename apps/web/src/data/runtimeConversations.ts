export type RuntimeConversation = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
};

export const initialRuntimeConversations: RuntimeConversation[] = [
  {
    id: "t1",
    title: "Product chat",
    preview: "A live conversation with Konan",
    updatedAt: 0,
  },
];

export function titleFromMessage(message: string) {
  const firstLine = message.trim().split("\n", 1)[0] ?? "New conversation";
  return firstLine.length > 46 ? `${firstLine.slice(0, 45).trimEnd()}…` : firstLine;
}
