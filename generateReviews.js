const fs = require("fs");

// Nick parçaları (karıştırarak üretilecek)
const prefixes = ["fnl","pro","x","dark","king","baby","real","neo","ultra","ghost","shadow","turk","fast","vip","hyper"];
const middles = ["lynx","piro","core","fire","zone","play","tech","nova","storm","byte","craft","edge","zone","xen","flux"];
const suffixes = ["x","TR","01","99","zz","pro","hd","yt","live","gg","fps","tv","bt","mod","exe"];

// Yorum parçaları
const starts = [
  "ürünü aldım",
  "ilk alışverişimdi",
  "biraz tereddüt ettim ama",
  "denemek için aldım",
  "arkadaş tavsiyesiyle aldım",
  "uzun süredir bakıyordum",
  "ilk başta güvenemedim ama",
  "merak edip aldım"
];

const middlesText = [
  "gayet memnun kaldım",
  "beklediğimden iyi çıktı",
  "sorunsuz geldi",
  "hızlı teslim edildi",
  "şu anlık sıkıntı yok",
  "gayet iyi çalışıyor",
  "anlatıldığı gibi geldi",
  "fiyatına göre iyi"
];

const ends = [
  "tekrar alırım",
  "tavsiye ederim",
  "güzel hizmet",
  "sorun yaşamadım",
  "memnun kaldım",
  "her şey düzgün",
  "başarılı",
  "gayet iyi"
];

// Random nick üretici
function generateNick() {
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const m = middles[Math.floor(Math.random() * middles.length)];
  const s = suffixes[Math.floor(Math.random() * suffixes.length)];
  const num = Math.random() > 0.5 ? Math.floor(Math.random() * 999) : "";
  return p + m + s + num;
}

// Random yorum üretici
function generateComment() {
  const s = starts[Math.floor(Math.random() * starts.length)];
  const m = middlesText[Math.floor(Math.random() * middlesText.length)];
  const e = ends[Math.floor(Math.random() * ends.length)];
  return `${s} ${m}, ${e}`;
}

// Unique üretim
let used = new Set();
let reviews = [];

while (reviews.length < 129) {
  const user = generateNick();
  const text = generateComment();

  const key = user + text;

  if (!used.has(key)) {
    used.add(key);
    reviews.push({ user, text });
  }
}

fs.writeFileSync("reviews.json", JSON.stringify({ demo: true, reviews }, null, 2));

console.log("🔥 129 farklı nickli yorum oluşturuldu");