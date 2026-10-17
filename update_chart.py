"""멜론 TOP100 차트를 가져와 data/latest.json 으로 저장합니다.

- 멜론 접속이 막히거나 데이터가 이상하면 기존 파일은 건드리지 않고 종료합니다(종료 코드 1).
- 멜론 차트 시각(예: 2026.10.17 20:00)이 이전과 같으면 아무것도 바꾸지 않습니다.
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"
LATEST = DATA_DIR / "latest.json"
USB_XLSX = ROOT / "분위기별_추천곡_250.xlsx"

CHART_URL = "https://www.melon.com/chart/index.htm"
LIKE_URL = "https://www.melon.com/commonlike/getSongLike.json"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
}
KST = timezone(timedelta(hours=9))

# 엑셀(영문 표기)과 멜론(한글 표기)이 다른 아티스트 이름을 서로 연결합니다.
ARTIST_ALIASES = [
    ["BTS", "방탄소년단"], ["ZICO", "지코"], ["SEVENTEEN", "세븐틴"],
    ["BIGBANG", "빅뱅"], ["BLACKPINK", "블랙핑크"], ["SHINee", "샤이니"],
    ["TXT", "투모로우바이투게더", "TOMORROW X TOGETHER"], ["EXO", "엑소"],
    ["Stray Kids", "스트레이 키즈"], ["ENHYPEN", "엔하이픈"], ["ATEEZ", "에이티즈"],
    ["DAY6", "데이식스"], ["RIIZE", "라이즈"], ["BOYNEXTDOOR", "보이넥스트도어"],
    ["ZEROBASEONE", "제로베이스원"], ["TWS", "투어스"], ["PLAVE", "플레이브"],
    ["TREASURE", "트레저"], ["WINNER", "위너"], ["iKON", "아이콘"],
    ["Wanna One", "워너원"], ["Block B", "블락비"], ["BTOB", "비투비"],
    ["JENNIE", "제니"], ["LISA", "리사"], ["ROSÉ", "로제", "ROSE"],
    ["G-DRAGON", "지드래곤", "GD"], ["Agust D", "어거스트 디", "SUGA", "슈가"],
    ["MINO", "송민호"], ["RM", "알엠"], ["V", "뷔"], ["j-hope", "제이홉"],
    ["정국", "Jung Kook", "JungKook"], ["지민", "Jimin"], ["진", "Jin"],
    ["지수", "JISOO"], ["태민", "TAEMIN"], ["태양", "TAEYANG"],
    ["슈퍼주니어", "SUPER JUNIOR"], ["이승철", "Lee Seung Chul"],
    ["NCT 127", "엔시티 127"], ["NCT DREAM", "엔시티 드림"], ["NCT U", "엔시티 유"],
    ["Bruno Mars", "브루노 마스"],
]


def norm(text):
    """비교용으로 대소문자·공백·기호를 없앤 문자열."""
    text = unicodedata.normalize("NFKC", str(text or "")).lower()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))  # é → e
    text = unicodedata.normalize("NFC", text)  # 한글 자모를 다시 합침
    return re.sub(r"[^0-9a-z가-힣]", "", text)


def clean(text):
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def title_keys(title):
    """'뛰어(JUMP)' → {'뛰어jump', '뛰어', 'jump'} 처럼 괄호 안팎을 모두 비교 대상으로."""
    title = str(title or "")
    keys = {norm(title), norm(re.sub(r"\(.*?\)|\[.*?\]", "", title))}
    keys |= {norm(inner) for inner in re.findall(r"[(\[](.*?)[)\]]", title)}
    return keys - {""}


ALIAS_INDEX = {}
for group in ARTIST_ALIASES:
    keys = {norm(name) for name in group} - {""}
    for k in keys:
        ALIAS_INDEX.setdefault(k, set()).update(keys)


def artist_keys(artist):
    """'지코 (ZICO), 크러쉬' → {'지코','zico','크러쉬'} + 별칭."""
    names = re.split(r",|&|\band\b|\bwith\b|\bfeat\.?|\bx\b|×", str(artist or ""), flags=re.I)
    keys = set()
    for name in names:
        for part in re.split(r"[()]", name):
            k = norm(part)
            if k:
                keys.add(k)
                keys |= ALIAS_INDEX.get(k, set())
    return keys


def load_usb_list():
    if not USB_XLSX.exists():
        print(f"[안내] {USB_XLSX.name} 파일이 없어 '내 USB' 표시는 건너뜁니다.")
        return {}
    import openpyxl

    wb = openpyxl.load_workbook(USB_XLSX, read_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [str(h or "").strip() for h in next(rows)]
    ti, ai = header.index("곡명"), header.index("아티스트")
    usb = {}
    for row in rows:
        if row[ti]:
            for k in title_keys(row[ti]):
                usb.setdefault(k, []).append(artist_keys(row[ai]))
    return usb


def in_usb(usb, title, artist):
    keys = artist_keys(artist)
    return any(keys & c for k in title_keys(title) for c in usb.get(k, []))


def fetch_chart():
    resp = requests.get(CHART_URL, headers=HEADERS, timeout=30)
    print(f"[멜론] 차트 페이지 응답: HTTP {resp.status_code}, {len(resp.text):,}자")
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    day = soup.select_one(".calendar_prid span.year")
    hour = soup.select_one(".calendar_prid span.hour")
    chart_time = f"{day.get_text(strip=True)} {hour.get_text(strip=True)}" if day and hour else None

    songs = []
    for tr in soup.select("tr.lst50, tr.lst100"):
        song_id = tr.get("data-song-no")
        rank = tr.select_one("span.rank")
        title = tr.select_one("div.rank01 a")
        artists = tr.select("div.rank02 > a")
        album = tr.select_one("div.rank03 a")
        img = tr.select_one("a.image_typeAll img")
        if not (song_id and rank and title):
            continue

        # 멜론 자체 순위 변동(이전 데이터가 없을 때만 사용)
        melon_change = {"type": "same", "amount": 0}
        wrap = tr.select_one(".rank_wrap")
        if wrap:
            cls = " ".join(" ".join(s.get("class", [])) for s in wrap.select("span"))
            num = re.search(r"\d+", wrap.get_text(" ", strip=True))
            amount = int(num.group()) if num else 0
            if "rank_new" in cls:
                melon_change = {"type": "new", "amount": 0}
            elif "rank_up" in cls:
                melon_change = {"type": "up", "amount": amount}
            elif "rank_down" in cls:
                melon_change = {"type": "down", "amount": amount}

        image = img.get("src", "") if img else ""
        image = re.sub(r"/resize/\d+/", "/resize/240/", image)  # 휴대폰에서 선명하게

        songs.append({
            "rank": int(rank.get_text(strip=True)),
            "song_id": song_id,
            "title": clean(title.get_text()),
            "artist": ", ".join(clean(a.get_text()) for a in artists),
            "album": clean(album.get_text()) if album else "",
            "image": image,
            "url": f"https://www.melon.com/song/detail.htm?songId={song_id}",
            "likes": None,
            "_melon_change": melon_change,
        })
    return chart_time, songs


def fetch_likes(songs):
    """좋아요 수는 별도 주소에서 받아옵니다. 실패해도 차트는 그대로 저장합니다."""
    try:
        resp = requests.get(
            LIKE_URL,
            params={"contsIds": ",".join(s["song_id"] for s in songs)},
            headers={**HEADERS, "Referer": CHART_URL, "X-Requested-With": "XMLHttpRequest"},
            timeout=30,
        )
        resp.raise_for_status()
        likes = {str(x["CONTSID"]): x.get("SUMMCNT") for x in resp.json().get("contsLike", [])}
        for s in songs:
            s["likes"] = likes.get(s["song_id"])
        print(f"[멜론] 좋아요 수 {len(likes)}곡 받아옴")
    except Exception as e:  # noqa: BLE001
        print(f"[경고] 좋아요 수를 가져오지 못했습니다: {e}")


def main():
    try:
        chart_time, songs = fetch_chart()
    except Exception as e:  # noqa: BLE001
        print(f"[실패] 멜론 접속 실패 — 기존 데이터를 그대로 둡니다. 원인: {e}")
        return 1

    if len(songs) < 90:
        print(f"[실패] 곡이 {len(songs)}개뿐입니다(차단/페이지 변경 의심) — 기존 데이터를 그대로 둡니다.")
        return 1
    print(f"[멜론] {len(songs)}곡 읽음, 멜론 차트 시각: {chart_time}")

    previous = None
    if LATEST.exists():
        try:
            previous = json.loads(LATEST.read_text(encoding="utf-8"))
        except ValueError:
            previous = None

    if previous and chart_time and previous.get("chart_time") == chart_time:
        print("[안내] 멜론 차트가 아직 갱신되지 않았습니다. 변경 없음.")
        return 0

    fetch_likes(songs)

    usb = load_usb_list()
    prev_rank = {s["song_id"]: s["rank"] for s in previous["songs"]} if previous else None
    for s in songs:
        melon_change = s.pop("_melon_change")
        if prev_rank is None:
            s["change"] = melon_change
        elif s["song_id"] not in prev_rank:
            s["change"] = {"type": "new", "amount": 0}
        else:
            diff = prev_rank[s["song_id"]] - s["rank"]
            s["change"] = {"type": "up" if diff > 0 else "down" if diff < 0 else "same", "amount": abs(diff)}
        s["in_usb"] = in_usb(usb, s["title"], s["artist"])

    now = datetime.now(KST)
    result = {
        "updated_at": now.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
        "chart_time": chart_time,
        "songs": songs,
    }

    DATA_DIR.mkdir(exist_ok=True)
    HISTORY_DIR.mkdir(exist_ok=True)
    tmp = LATEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(LATEST)

    # 날짜별 기록: 그날의 마지막 차트를 간단한 형태로 보관
    history = {
        "updated_at": result["updated_at"],
        "chart_time": chart_time,
        "songs": [{k: s[k] for k in ("rank", "song_id", "title", "artist", "likes")} for s in songs],
    }
    (HISTORY_DIR / f"{now:%Y-%m-%d}.json").write_text(
        json.dumps(history, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    usb_count = sum(s["in_usb"] for s in songs)
    print(f"[완료] 저장했습니다. 1위: {songs[0]['title']} - {songs[0]['artist']}, 내 USB 곡: {usb_count}곡")
    return 0


if __name__ == "__main__":
    sys.exit(main())
