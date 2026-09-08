const { Country, State } = require("country-state-city");

function countries() {
  return Country.getAllCountries().map((country) => ({ code: country.isoCode, name: country.name })).sort((a, b) => a.name.localeCompare(b.name));
}

function country(codeOrName) {
  const value = String(codeOrName || "").trim().toLowerCase();
  return Country.getAllCountries().find((item) => item.isoCode.toLowerCase() === value || item.name.toLowerCase() === value) || null;
}

function states(countryCode) {
  return State.getStatesOfCountry(String(countryCode || "").toUpperCase()).map((state) => ({ code: state.isoCode, name: state.name })).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { countries, country, states };
