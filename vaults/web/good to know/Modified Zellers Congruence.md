# Modified Zeller's Congruence

*An Adjusted Mental-Math Algorithm to Find the Day of the Week for Any Date in the Gregorian Calendar*

## 1. Master Reference Codes

### Updated Month Codes

**Jan** = 1 | **Feb** = 4 | **Mar** = 4 | **Apr** = 0 | **May** = 2 | **Jun** = 5 | **Jul** = 0 | **Aug** = 3 | **Sep** = 6 | **Oct** = 1 | **Nov** = 4 | **Dec** = 6

### Century Codes & The 400-Year Cycle

**1600s** = 6 | **1700s** = 4 | **1800s** = 2 | **1900s** = 0 | **2000s** = 6 | **2100s** = 4 | **2200s** = 2 | **2300s** = 0

**400-Year Cycle Rule:** Because 400 Gregorian years contain exactly 146,097 days (which is divisible by 7), century codes repeat infinitely in the pattern **6 → 4 → 2 → 0** every four centuries.

### Day Mapping

**0** = Saturday | **1** = Sunday | **2** = Monday | **3** = Tuesday | **4** = Wednesday | **5** = Thursday | **6** = Friday

---

## 2. Algorithm Steps & Leap Year Rule

1. **Calculate Year Code:** Last two digits of the year + (Last two digits ÷ 4, ignore the remainder).
2. **Add Day and Month Code:** Day + Month Code from the updated list.
3. **Leap Year Adjustment:** If it is a leap year and the month is before March (Jan or Feb), subtract 1.
4. **Add Century Code:** Add the corresponding code for the century.
5. **Calculate the Day of the Week:** Add all values together and take modulo 7 (divide by 7 and find the remainder).

> **Critical Rule — What Counts as a Leap Year?** A year is a leap year if it is divisible by **4**, *except* end-of-century years (ending in **00**), which must be divisible by **400**. Thus, **2000 and 1600** are leap years, whereas **1900, 2100, and 2200 are NOT leap years** (do not subtract 1 in Jan/Feb of 1900 or 2100).

---

## 3. Example Calculations

### Example A: July 4, 2024
*(Standard post-February date)*

**Breakdown:**
* **Last Two Digits of Year:** 24
* **Year Code:** `24 + (24 ÷ 4) = 24 + 6 = 30`
* **Month Code:** July = 0
* **Day:** 4

**Calculations:**
* **Year + Day + Month:** `30 + 4 + 0 = 34`
* **Leap Adjustment:** `0` *(after Feb)*
* **Century Code (2000s):** 6
* **Total:** `34 + 6 = 40`
* **Day of Week:** `40 % 7 = 5`

**Result:** Day mapping for 5 is **Thursday**.

### Example B: Feb 29, 2024
*(Leap year Jan/Feb date requiring Step 3)*

**Breakdown:**
* **Last Two Digits of Year:** 24
* **Year Code:** `24 + (24 ÷ 4) = 24 + 6 = 30`
* **Month Code:** Feb = 4
* **Day:** 29

**Calculations:**
* **Year + Day + Month:** `30 + 29 + 4 = 63`
* **Leap Adjustment:** `-1` *(leap & Feb)*
* **Century Code (2000s):** 6
* **Total:** `63 - 1 + 6 = 68`
* **Day of Week:** `68 % 7 = 5`

**Result:** Day mapping for 5 is **Thursday**.

---

## 4. Month Code Memory Aids

### Mnemonics for Quick Recall (144 – 025 – 036 – 146)

* **Jan = 1:** First month of the year.
* **Feb = 4:** Month of Love—Heart. Hearts have 4 chambers (also **144 = 12²** for Jan–Feb–Mar).
* **Mar = 4:** "March 4th"—a self-evident pun.
* **Apr = 0:** 0 trust on April (Fools' Day) (also **025 = 5²** for Apr–May–Jun).
* **May = 2:** Gemini starts on May 21, and Gemini is two (twins).
* **Jun = 5:** World Environment Day is June 5th.
* **Jul = 0:** 0 work (Summer vacation / July 4th) (also **036 = 6²** for Jul–Aug–Sep).
* **Aug = 3:** Augustus, triumvirate (rule of 3).
* **Sep = 6:** National Bee month for NZ; a bee's honeycomb is a hexagon (6 sides).
* **Oct = 1:** One-eyed Halloween cyclops/monster (also **146 = 12² + 2** for Oct–Nov–Dec).
* **Nov = 4:** Thanksgiving is the 4th Thursday of November.
* **Dec = 6:** Winter; snowflakes have 6 edges.

<!-- OBSIDIAN-WEB-START -->
---
### 🕸️ Neural Graph Connections
#### 📘 Connected Deep-Dive Chapters
- [[14. Shad-Darshana, Vedanta & Indigenous Sciences]]
- [[7. Supercomputing, Quantum Computing, PQC & Blockchain]]

#### 🔗 Related Compendiums
- [[Heuristics and Razors]]
<!-- OBSIDIAN-WEB-END -->
