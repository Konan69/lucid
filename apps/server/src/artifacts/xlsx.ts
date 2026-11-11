/** The Computer image pins openpyxl at /opt/vivid/python. Read only the immutable capture,
 * cap disclosure to ten A1:E5 rectangles, and name everything outside those rectangles.
 * Each rectangle fits the runtime’s 25-cell list limit. Two passes distinguish a formula from its possibly absent or stale stored result. */
export const workbookInspection = (directory: string) => `
/opt/vivid/python/bin/python3 - '${directory}' <<'VIVID_WORKBOOK'
import json, pathlib, sys
from openpyxl import load_workbook

root = pathlib.Path(sys.argv[1])
formulas = load_workbook(root / 'input.xlsx', read_only=True, data_only=False)
values = load_workbook(root / 'input.xlsx', read_only=True, data_only=True)
sheets = []
for sheet in formulas.worksheets[:10]:
    cells = []
    stored = values[sheet.title]
    rows = sheet.iter_rows(min_row=1, max_row=5, min_col=1, max_col=5)
    cached = stored.iter_rows(min_row=1, max_row=5, min_col=1, max_col=5)
    for row, cache in zip(rows, cached):
        for cell, value in zip(row, cache):
            if cell.value is None:
                continue
            formula = str(cell.value) if cell.data_type == 'f' else None
            raw = value.value if formula is not None else cell.value
            text = None if raw is None else str(raw)
            cells.append({
                'address': cell.coordinate,
                'value': None if text is None else text[:200],
                'formula': None if formula is None else formula[:200],
                'truncated': (text is not None and len(text) > 200) or (formula is not None and len(formula) > 200),
            })
    sheets.append({
        'name': sheet.title,
        'inspectedRange': 'A1:E5',
        'usedRange': sheet.calculate_dimension(),
        'cells': cells,
    })
result = {'sheets': sheets, 'omittedSheets': formulas.sheetnames[10:]}
(root / 'inspection.json').write_text(json.dumps(result), encoding='utf-8')
values.close()
formulas.close()
VIVID_WORKBOOK
`
