import { describe, expect, it, vi } from "vitest";
import {
  READ_STATUS_STORAGE_KEY,
  readReadStatus,
  writeReadStatus,
} from "@/components/feed/read-status-storage";

function storageWith(value: string | null) {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
  };
}

describe("read status storage", () => {
  it("V1 を ID の重複なし集合として復元し、ID だけを保存する", () => {
    const storage = storageWith('{"version":1,"readCardIds":["1","1","2"]}');
    expect(readReadStatus(storage)).toEqual({ readCardIds: ["1", "2"], shouldRepair: true });

    writeReadStatus(storage, ["2", "2", "3"]);
    expect(storage.setItem).toHaveBeenCalledWith(
      READ_STATUS_STORAGE_KEY,
      '{"version":1,"readCardIds":["2","3"]}',
    );
  });

  it("壊れた既知 V1 は安全に空として扱い、未知 version は破壊しない", () => {
    expect(readReadStatus(storageWith('{"version":1,"readCardIds":[1,"",null]}'))).toEqual({
      readCardIds: [],
      shouldRepair: true,
    });
    expect(readReadStatus(storageWith('{"version":2,"readCardIds":["future"]}'))).toEqual({
      readCardIds: [],
      shouldRepair: false,
    });
  });

  it("余分なカード情報を含む V1 は ID-only 形式へ修復対象とする", () => {
    const storage = storageWith('{"version":1,"readCardIds":["1"],"title":"本文ではない"}');
    expect(readReadStatus(storage)).toEqual({ readCardIds: ["1"], shouldRepair: true });
    writeReadStatus(storage, ["1"]);
    const persisted = String(storage.setItem.mock.calls[0]?.[1]);
    expect(persisted).not.toContain("title");
    expect(persisted).not.toContain("url");
    expect(persisted).not.toContain("本文");
  });

  it("Storage の読み書き例外を呼び出し元へ漏らさない", () => {
    expect(
      readReadStatus({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual({
      readCardIds: [],
      shouldRepair: false,
    });
    expect(
      writeReadStatus(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        ["1"],
      ),
    ).toBe(false);
  });
});
