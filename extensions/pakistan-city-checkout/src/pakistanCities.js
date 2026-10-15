// Canonical English city names used by the Pakistan checkout selector.
// Keep these values stable because the selected value is sent to the booking API.
export const PAKISTAN_CITIES = [
  "Abbottabad", "Astore", "Attock", "Awaran", "Badin", "Bahawalnagar", "Bahawalpur", "Bajaur",
  "Bannu", "Barkhan", "Battagram", "Bhakkar", "Buner", "Chagai", "Charsadda", "Chichawatni",
  "Chiniot", "Chitral", "Dadu", "Dera Ghazi Khan", "Dera Ismail Khan", "Dera Bugti", "Daska",
  "Diamer", "Dir", "Faisalabad", "Ghotki", "Gilgit", "Gojra", "Gujar Khan", "Gujranwala",
  "Gujrat", "Gwadar", "Hafizabad", "Hangu", "Haripur", "Harnai", "Hyderabad", "Islamabad",
  "Jacobabad", "Jafarabad", "Jhang", "Jhelum", "Kalat", "Karachi", "Karak", "Kashmore",
  "Kasur", "Khairpur", "Khanewal", "Khuzdar", "Khyber", "Killa Abdullah", "Killa Saifullah",
  "Kohat", "Kotli", "Kurram", "Lahore", "Lakki Marwat", "Larkana", "Lasbela", "Layyah",
  "Lodhran", "Lower Dir", "Malakand", "Mandi Bahauddin", "Mansehra", "Mardan", "Mastung",
  "Matiari", "Mianwali", "Mirpur", "Mirpur Khas", "Mohmand", "Multan", "Muzaffarabad",
  "Muzaffargarh", "Murree", "Nagar", "Nankana Sahib", "Narowal", "Naseerabad", "Naushahro Feroze",
  "Nawabshah", "Nowshera", "North Waziristan", "Okara", "Orakzai", "Pakpattan", "Peshawar",
  "Pishin", "Qambar Shahdadkot", "Quetta", "Rahim Yar Khan", "Rajanpur", "Rawalakot", "Rawalpindi",
  "Sahiwal", "Sanghar", "Sargodha", "Shaheed Benazirabad", "Shangla", "Sheikhupura", "Sherani",
  "Shikarpur", "Sialkot", "Sibi", "Skardu", "South Waziristan", "Sudhanoti", "Sukkur", "Swabi",
  "Swat", "Tando Allahyar", "Tando Muhammad Khan", "Tank", "Taxila", "Tharparkar", "Thatta",
  "Toba Tek Singh", "Torghar", "Turbat", "Umerkot", "Upper Dir", "Vehari", "Washuk", "Zhob",
  "Ziarat", "Daska", "Dera Allah Yar", "Gujranwala", "Hala", "Kamoke", "Kandhkot", "Khanpur",
  "Khushab", "Kot Addu", "Mingora", "Mithi", "Moro", "Nawabshah", "Pano Aqil", "Sadiqabad",
  "Sambrial", "Shahdadpur", "Tando Adam", "Wazirabad", "Wah Cantt", "Chakwal", "Jhelum", "Muridke",
  "Sakrand", "Liaquatpur", "Dera Ismail Khan", "Mian Channu", "Shorkot", "Hujra Shah Muqeem",
  "Kharian", "Mandi Bahauddin", "Pattoki", "Renala Khurd", "Arifwala", "Bhalwal", "Dinga",
  "Jaranwala", "Kamalia", "Kamber", "Khipro", "Kotri", "Lodhran", "Moro", "Tando Jam",
].filter((city, index, cities) => cities.indexOf(city) === index).sort((left, right) => left.localeCompare(right));

export function isPakistanCity(value) {
  return PAKISTAN_CITIES.some((city) => city.toLowerCase() === String(value || "").trim().toLowerCase());
}
