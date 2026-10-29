import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import ExcelJS from "exceljs";
import type { Logger } from "../logger.js";

export type GuestExportFormat = "xlsx" | "csv" | "docx";

export type GuestExportFile = {
  path: string;
  fileName: string;
  format: GuestExportFormat;
  rowCount: number;
};

type ExportRequest = {
  turnId: string;
  title: string;
  fileName: string;
  format: GuestExportFormat;
  rows: Array<Record<string, unknown>>;
  columnLabels?: Record<string, string>;
};

const MAX_COLUMNS = 60;
const MAX_CELL_TEXT = 10_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class GuestExportManager {
  private readonly filesByTurn = new Map<string, GuestExportFile[]>();

  constructor(
    private readonly root: string,
    private readonly maxRows: number,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanupExpiredFiles();
  }

  async create(request: ExportRequest): Promise<GuestExportFile> {
    const rows = request.rows.slice(0, this.maxRows).map(normalizeRow);
    if (rows.length === 0) throw new Error("没有可导出的数据行。");
    const columns = collectColumns(rows);
    if (columns.length === 0) throw new Error("导出数据没有可用字段。");
    if (columns.length > MAX_COLUMNS) throw new Error(`导出字段不能超过 ${MAX_COLUMNS} 列。`);

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const requestedName = sanitizeFileName(request.fileName || request.title || "数据导出", request.format);
    const internalName = `${Date.now()}-${randomUUID()}-${requestedName}`;
    const path = join(this.root, internalName);
    const labels = request.columnLabels ?? {};

    if (request.format === "xlsx") {
      await writeXlsx(path, request.title, columns, labels, rows);
    } else if (request.format === "docx") {
      await writeDocx(path, request.title, columns, labels, rows);
    } else {
      await writeCsv(path, columns, labels, rows);
    }
    await chmod(path, 0o600);

    const file: GuestExportFile = {
      path,
      fileName: requestedName,
      format: request.format,
      rowCount: rows.length,
    };
    const existing = this.filesByTurn.get(request.turnId) ?? [];
    existing.push(file);
    this.filesByTurn.set(request.turnId, existing);
    this.logger.info("访客导出文件已生成", {
      turnId: request.turnId,
      fileName: requestedName,
      format: request.format,
      rowCount: rows.length,
    });
    return file;
  }

  takeFiles(turnId: string): GuestExportFile[] {
    const files = this.filesByTurn.get(turnId) ?? [];
    this.filesByTurn.delete(turnId);
    return files;
  }

  async removeFiles(files: GuestExportFile[]): Promise<void> {
    await Promise.all(
      files.map((file) =>
        unlink(file.path).catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") this.logger.warn("清理访客导出文件失败", { fileName: file.fileName, code });
        }),
      ),
    );
  }

  private async cleanupExpiredFiles(): Promise<void> {
    const cutoff = Date.now() - DEFAULT_RETENTION_MS;
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const path = join(this.root, entry.name);
        const metadata = await stat(path).catch(() => null);
        if (metadata && metadata.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
      }),
    );
  }
}

async function writeXlsx(
  path: string,
  title: string,
  columns: string[],
  labels: Record<string, string>,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex Feishu Bridge";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("数据", { views: [{ state: "frozen", ySplit: 2 }] });
  sheet.mergeCells(1, 1, 1, columns.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = truncateCell(title || "数据导出");
  titleCell.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 28;

  const header = sheet.getRow(2);
  header.values = columns.map((key) => truncateCell(labels[key] || key));
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 24;

  for (const row of rows) {
    const excelRow = sheet.addRow(columns.map((key) => excelValue(row[key])));
    excelRow.alignment = { vertical: "top", wrapText: true };
  }
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
  for (let index = 0; index < columns.length; index += 1) {
    const key = columns[index]!;
    const values = rows.slice(0, 200).map((row) => displayText(row[key]));
    const longest = Math.max((labels[key] || key).length, ...values.map((value) => value.length));
    sheet.getColumn(index + 1).width = Math.max(10, Math.min(36, longest + 2));
  }
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 3) return;
    if (rowNumber % 2 === 1) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FA" } };
    }
  });
  await workbook.xlsx.writeFile(path);
}

async function writeCsv(
  path: string,
  columns: string[],
  labels: Record<string, string>,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const lines = [columns.map((key) => csvCell(labels[key] || key)).join(",")];
  for (const row of rows) lines.push(columns.map((key) => csvCell(row[key])).join(","));
  await writeFile(path, `\uFEFF${lines.join("\r\n")}\r\n`, { mode: 0o600 });
}

async function writeDocx(
  path: string,
  title: string,
  columns: string[],
  labels: Record<string, string>,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const tableRows = [
    new TableRow({
      tableHeader: true,
      children: columns.map(
        (key) =>
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: labels[key] || key, bold: true })] })],
          }),
      ),
    }),
    ...rows.map(
      (row) =>
        new TableRow({
          children: columns.map(
            (key) => new TableCell({ children: [new Paragraph({ text: displayText(row[key]) })] }),
          ),
        }),
    ),
  ];
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: truncateCell(title || "数据导出"), heading: HeadingLevel.TITLE }),
          new Paragraph({ text: `共 ${rows.length} 条记录` }),
          new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }),
        ],
      },
    ],
  });
  await writeFile(path, await Packer.toBuffer(document), { mode: 0o600 });
}

function collectColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [truncateCell(key), normalizeCell(value)]));
}

function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return "[binary]";
  if (typeof value === "string") return truncateCell(value);
  return truncateCell(JSON.stringify(value));
}

function excelValue(value: unknown): string | number | boolean | null {
  return normalizeCell(value);
}

function displayText(value: unknown): string {
  const normalized = normalizeCell(value);
  return normalized === null ? "" : String(normalized);
}

function csvCell(value: unknown): string {
  let text = displayText(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function truncateCell(value: string): string {
  return value.length <= MAX_CELL_TEXT ? value : `${value.slice(0, MAX_CELL_TEXT)}…`;
}

function sanitizeFileName(value: string, format: GuestExportFormat): string {
  const extension = `.${format}`;
  const base = value
    .replace(/[\u0000-\u001F\u007F/\\:*?"<>|]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100) || "数据导出";
  const withoutExtension = extname(base) ? base.slice(0, -extname(base).length) : base;
  return `${withoutExtension}${extension}`;
}
