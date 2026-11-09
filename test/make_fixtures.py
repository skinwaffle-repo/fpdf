"""Generate test PDFs: a realistic invoice with embedded subset TrueType fonts, and an AcroForm."""
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

out = sys.argv[1]
pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVuB", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DejaVuSerif", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"))

c = canvas.Canvas(f"{out}/invoice.pdf", pagesize=A4)
c.setTitle("Faktura testowa"); c.setAuthor("Test Author")
for p in range(3):
    c.setFont("DejaVuB", 22); c.drawString(60, 770, f"FAKTURA VAT nr {p+1}/11/2026")
    c.setFont("DejaVu", 11)
    y = 730
    for line in ["Sprzedawca: Dynamic Sp. z o.o., ul. Zażółć 12, Gdańsk",
                 "Nabywca: Jan Kowalski, ul. Gęślą 5, Łódź",
                 "Termin płatności: 14 dni. Kwota do zapłaty: 1 234,56 zł",
                 "This line stays untouched for the neighbour test."]:
        c.drawString(60, y, line); y -= 16
    c.setFont("DejaVuSerif", 12); c.setFillColorRGB(0.1, 0.2, 0.7)
    c.drawString(60, 640, "Blue serif paragraph text, page %d." % (p + 1))
    c.setFillColorRGB(0, 0, 0)
    c.rect(60, 500, 470, 100)
    c.setFont("DejaVu", 9); c.drawString(70, 580, "Table cell content inside a box")
    c.showPage()
c.save()

c = canvas.Canvas(f"{out}/form.pdf", pagesize=A4)
c.setFont("Helvetica", 12)
c.drawString(60, 760, "Name:")
c.acroForm.textfield(name="name", x=120, y=750, width=250, height=20, borderWidth=1)
c.drawString(60, 720, "Agree:")
c.acroForm.checkbox(name="agree", x=120, y=715, size=16)
c.drawString(60, 680, "Country:")
c.acroForm.choice(name="country", x=120, y=670, width=150, height=20, options=["Poland", "Ireland", "UK"], value="Poland")
c.showPage(); c.save()
print("ok")
