"""Demo document used for screenshots and UI tests (all names invented)."""
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white, black
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

out = sys.argv[1] if len(sys.argv) > 1 else "test/fixtures/demo.pdf"
D = "/usr/share/fonts/truetype/dejavu/"
pdfmetrics.registerFont(TTFont("Sans", D + "DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("SansB", D + "DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Serif", D + "DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("SerifB", D + "DejaVuSerif-Bold.ttf"))
W, H = A4
c = canvas.Canvas(out, pagesize=A4)
c.setTitle("Invoice 2026-0114"); c.setAuthor("Grumpy Goat Supply Co.")

# ---------------------------------------------------------------- page 1: invoice
c.setFillColor(HexColor("#141414")); c.rect(0, H - 150, W, 150, stroke=0, fill=1)
c.setFillColor(white); c.setFont("SansB", 34); c.drawString(50, H - 80, "INVOICE")
c.setFillColor(HexColor("#bdbdbd")); c.setFont("Sans", 12); c.drawString(52, H - 104, "No. 2026-0114   |   issued 9 November 2026")
c.setFillColor(white); c.setFont("SansB", 13); c.drawRightString(W - 50, H - 74, "Grumpy Goat Supply Co.")
c.setFillColor(HexColor("#d0d0d0")); c.setFont("Sans", 10)
c.drawRightString(W - 50, H - 92, "12 Hay Lane, Goatsville"); c.drawRightString(W - 50, H - 106, "hello@grumpygoat.example")
c.setFillColor(black); c.setFont("SansB", 10); c.drawString(50, H - 190, "BILL TO")
c.setFont("Sans", 11)
for k, t in enumerate(["Jan Kowalski", "ul. Zażółć 7/3", "00-950 Warszawa"]): c.drawString(50, H - 208 - k * 15, t)
c.setFont("SansB", 10); c.drawString(330, H - 190, "PAYMENT DUE"); c.setFont("Sans", 11); c.drawString(330, H - 208, "23 November 2026")
y = H - 290
c.setFillColor(HexColor("#f0f0f0")); c.rect(50, y - 6, W - 100, 22, stroke=0, fill=1); c.setFillColor(black)
c.setFont("SansB", 10)
for x, t in [(58, "ITEM"), (330, "QTY"), (400, "PRICE"), (W - 58, "TOTAL")]:
    (c.drawRightString if t == "TOTAL" else c.drawString)(x, y, t)
rows = [("Industrial goat brush, extra stiff", 3, 18.50), ("Hay bale, premium, 25 kg", 12, 9.90), ("Goat-proof gate latch", 2, 34.00), ("Consulting: why is the goat on the roof", 1, 120.00)]
c.setFont("Sans", 10.5); total = 0
for k, (name, q, p) in enumerate(rows):
    yy = y - 28 - k * 24; t = q * p; total += t
    c.drawString(58, yy, name); c.drawString(330, yy, str(q)); c.drawString(400, yy, f"{p:.2f} EUR"); c.drawRightString(W - 58, yy, f"{t:.2f} EUR")
    c.setStrokeColor(HexColor("#e2e2e2")); c.line(50, yy - 8, W - 50, yy - 8)
yy = y - 28 - len(rows) * 24 - 20
c.setFont("SansB", 13); c.drawString(330, yy, "TOTAL DUE"); c.drawRightString(W - 58, yy, f"{total:.2f} EUR")
c.setFont("Sans", 10); c.setFillColor(HexColor("#444444"))
c.drawString(50, 180, "Pay within 14 days. Late payments make the goat sad.")
c.drawString(50, 164, "Pay online: https://example.com/pay/2026-0114")
c.linkURL("https://example.com/pay/2026-0114", (50, 160, 330, 176), relative=0)
c.drawString(50, 148, "Terms: see page 2")
c.linkAbsolute("terms", "terms", Rect=(50, 144, 160, 160))
c.setFillColor(HexColor("#9a9a9a")); c.setFont("Sans", 8); c.drawString(50, 50, "Grumpy Goat Supply Co.  |  VAT ID XX0000000  |  thank you for your business")
c.showPage()

# ---------------------------------------------------------------- page 2: agreement
c.bookmarkPage("terms", fit="XYZ", top=H - 60)
c.setFont("SerifB", 20); c.drawString(60, H - 80, "Service Agreement")
c.setFont("Serif", 11)
paras = [
    "This agreement is made between Grumpy Goat Supply Co. (the \"Supplier\") and Jan Kowalski (the \"Customer\").",
    "1. The Supplier will deliver the goods listed on invoice 2026-0114 within ten working days of payment.",
    "2. The Customer agrees not to let the goat read this document, because it eats paper.",
    "3. Either party may end this agreement with thirty days written notice. Emails count. Carrier pigeons do not.",
    "4. Nothing in this agreement requires a subscription, an account, or a credit card to read, edit, or sign it.",
]
yy = H - 120
for ptxt in paras:
    words, line = ptxt.split(), ""
    for w in words:
        if c.stringWidth(line + " " + w, "Serif", 11) > W - 130:
            c.drawString(60, yy, line.strip()); yy -= 16; line = ""
        line += " " + w
    c.drawString(60, yy, line.strip()); yy -= 26
c.setStrokeColor(black)
for x, who in [(60, "Supplier"), (320, "Customer")]:
    c.line(x, 200, x + 200, 200); c.setFont("Serif", 10); c.drawString(x, 186, f"{who} signature and date")
c.showPage()

# ---------------------------------------------------------------- page 3: form
c.setFont("SansB", 20); c.drawString(60, H - 80, "Goat Club Registration")
c.setFont("Sans", 11)
form = c.acroForm
fields = [("Full name", "name"), ("Email", "email"), ("Goat's name", "goat")]
for k, (label, nm) in enumerate(fields):
    yy = H - 140 - k * 46
    c.drawString(60, yy + 6, label)
    form.textfield(name=nm, x=180, y=yy, width=300, height=22, borderWidth=1, borderColor=HexColor("#888888"), fillColor=white, textColor=black, fontSize=11)
yy = H - 140 - 3 * 46
c.drawString(60, yy + 6, "Membership")
form.choice(name="plan", x=180, y=yy, width=200, height=22, options=["Free forever", "Also free", "Still free"], value="Free forever", borderColor=HexColor("#888888"), fillColor=white)
yy -= 46
form.checkbox(name="terms", x=60, y=yy, size=16, borderColor=HexColor("#888888"), fillColor=white)
c.drawString(86, yy + 3, "I accept that the goat is in charge")
c.showPage()
c.save()
print("demo ok", out)
