const axios = require("axios");
const config = require("./config.json");
let patreon;
const path = require("path");
const fs = require("fs");
const util = require("util");
const readFile = util.promisify(fs.readFile);

const main = async () => {
  let skip = 0,
    currentPatrons = [],
    patronData;
  do {
    patronData = await getPatrons(skip);
    currentPatrons = currentPatrons.concat(patronData.data);
    skip += 10;
  } while (currentPatrons.length < patronData.total);

  console.log(`verifying ${patronData.total} patrons...`);

  patreon = await readFile(path.resolve(__dirname, config.patreonPath), "utf8")
    .then((data) => {
      return JSON.parse(data);
    })
    .catch((e) => {
      console.error(e);
      return null;
    });

  let isValid = await checkCreatorToken();
  if (!isValid) return await refreshCreatorToken();

  for (let patron of currentPatrons) {
    await verifyPatreon(patron);
    await sleep(300);
  }
  console.log("done");
};

const formUrlEncoded = (x) => Object.keys(x).reduce((p, c) => p + `&${c}=${encodeURIComponent(x[c])}`, "");

const verifyPatreon = async (user) => {
  let isValid = await checkUserToken(user.patreon.access_token);
  if (!isValid) {
    console.info(`${user.username}'s patreon token is expired. Trying to refresh...`);
    const tokens = await refreshUserToken(user.patreon.refresh_token);
    if (!tokens) {
      console.error(`could not refresh ${user.username}'s patreon tokens`);
      return destroyPatron(user);
    }
    user.patreon.access_token = tokens.access_token;
    user.patreon.refresh_token = tokens.refresh_token;

    axios({
      method: "PATCH",
      url: `https://sso.angelthump.com/users/${user.id}`,
      headers: {
        "x-api-key": config.apiKey,
      },
      data: {
        patreon: user.patreon,
      },
    }).catch((e) => {
      return console.error(e.message);
    });
  }

  const membership_id = await getMembershipId(user.patreon.access_token);
  if (!membership_id) return deletePatron(user);

  const patronData = await getPatronData(membership_id);
  if (!patronData) return deletePatron(user);

  if (!patronData.data.relationships.currently_entitled_tiers) return deletePatron(user);
  if (patronData.data.relationships.currently_entitled_tiers.data.length === 0) return;

  //get tier id then get tier data?
  const tier_id = patronData.data.relationships.currently_entitled_tiers.data[0].id;

  const tiers = await getTiers();

  if (!tiers) return console.error("failed to get tiers data");

  let userTier;
  for (let tier of tiers) {
    if (tier_id === tier.id) {
      userTier = tier;
      break;
    }
  }

  let newTier = 0,
    tierName = userTier.attributes.title;

  if (userTier.attributes.amount_cents === 100) {
    newTier = 0;
  } else if (userTier.attributes.amount_cents === 500) {
    newTier = 1;
  } else if (userTier.attributes.amount_cents === 1000) {
    newTier = 2;
  } else if (userTier.attributes.amount_cents === 1500) {
    newTier = 3;
  } else if (userTier.attributes.amount_cents === 3000) {
    newTier = 4;
  }

  //don't update if patron and same tier
  if (user.patreon.isPatron && user.patreon.tier === newTier) return;

  user.patreon.isPatron = true;
  user.patreon.tier = newTier;
  user.patreon.tierName = tierName;

  axios({
    method: "PATCH",
    url: `https://sso.angelthump.com/users/${user.id}`,
    headers: {
      "x-api-key": config.apiKey,
    },
    data: {
      patreon: user.patreon,
    },
  })
    .then(() => {
      console.info(`Updated ${user.username} with patreon: ${user.patreon.isPatron} | tier: ${user.patreon.tierName}`);
    })
    .catch((e) => {
      return console.error(e.message);
    });
};

const deletePatron = async (user) => {
  user.patreon.isPatron = false;
  user.patreon.tier = 0;
  user.patreon.tierName = "";
  user.password_protect = false;
  user.unlist = false;

  await axios({
    method: "PATCH",
    url: `https://sso.angelthump.com/users/${user.id}`,
    headers: {
      "x-api-key": config.apiKey,
    },
    data: {
      patreon: user.patreon,
    },
  })
    .then(() => {
      console.info(`${user.username} is no longer a patron.`);
    })
    .catch((e) => {
      return console.error(e.message);
    });
};

const destroyPatron = async (user) => {
  await axios({
    method: "PATCH",
    url: `https://sso.angelthump.com/users/${user.id}`,
    headers: {
      "x-api-key": config.apiKey,
    },
    data: {
      patreon: null,
      password_protect: false,
      unlist: false,
    },
  })
    .then(() => {
      console.info(`${user.username} is no longer a patron.`);
    })
    .catch((e) => {
      return console.error(e.message);
    });
};

const getTiers = async () => {
  let tiers;
  await axios
    .get(`https://www.patreon.com/api/oauth2/v2/campaigns/${patreon.campaignID}?include=tiers&fields%5Btier%5D=amount_cents,title`, {
      headers: {
        Authorization: `Bearer ${patreon.CREATOR_ACCESS_TOKEN}`,
      },
    })
    .then((response) => {
      if (!response.data.included) return;
      tiers = response.data.included;
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      console.log(e.response.data);
      if (e.response.data.errors[0].code !== 4) {
        return console.error(e.response.data);
      }
    });
  return tiers;
};

const checkUserToken = async (access_token) => {
  let isValid;
  await axios
    .get(`https://www.patreon.com/api/oauth2/v2/identity?include=memberships`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    })
    .then((response) => {
      if (response.status < 400) {
        isValid = true;
      }
    })
    .catch(async (e) => {
      if (!e.response) return console.error(e);
      if (e.response.status === 401) {
        return;
      }
      console.error(e.response.data);
    });
  return isValid;
};

const getMembershipId = async (access_token) => {
  let membership_id;
  await axios
    .get(`https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.campaign`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    })
    .then((response) => {
      if (!response.data.included) return;
      if (typeof response.data.included[Symbol.iterator] !== "function") return;
      for (const included of response.data.included) {
        if (!included.relationships) break;
        if (patreon.campaignID === included.relationships.campaign.data.id) {
          membership_id = included.id;
          break;
        }
      }
    })
    .catch(async (e) => {
      if (!e.response) return console.error(e);
      if (e.response.data.errors[0].code !== 4) {
        console.error(e.response.data);
      }
    });
  return membership_id;
};

const refreshUserToken = async (refresh_token) => {
  let tokens;
  await axios(`https://www.patreon.com/api/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: formUrlEncoded({
      grant_type: "refresh_token",
      refresh_token: refresh_token,
      client_id: patreon.CLIENT_ID,
      client_secret: patreon.CLIENT_SECRET,
    }),
  })
    .then((response) => {
      const data = response.data;
      tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      };
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      console.error(e.response.data);
    });
  return tokens;
};

const getPatronData = async (patronId) => {
  let patronData;
  await axios
    .get(
      `https://www.patreon.com/api/oauth2/v2/members/${patronId}?include=currently_entitled_tiers,user&fields%5Bmember%5D=patron_status,email,pledge_relationship_start,campaign_lifetime_support_cents,currently_entitled_amount_cents,last_charge_date,last_charge_status,will_pay_amount_cents`,
      {
        headers: {
          Authorization: `Bearer ${patreon.CREATOR_ACCESS_TOKEN}`,
        },
      }
    )
    .then((response) => {
      patronData = response.data;
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      console.log(e.response.data);
      if (e.response.data.errors[0].code !== 4) {
        return console.error(e.response.data);
      }
    });
  return patronData;
};

const refreshCreatorToken = async () => {
  await axios(`https://www.patreon.com/api/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: formUrlEncoded({
      grant_type: "refresh_token",
      refresh_token: patreon.CREATOR_REFRESH_TOKEN,
      client_id: patreon.CLIENT_ID,
      client_secret: patreon.CLIENT_SECRET,
    }),
  })
    .then((response) => {
      const data = response.data;
      patreon.CREATOR_ACCESS_TOKEN = data.access_token;
      patreon.CREATOR_REFRESH_TOKEN = data.refresh_token;
      fs.writeFile(path.resolve(__dirname, "../sso/config/patreon.json"), JSON.stringify(patreon, null, 4), (err) => {
        if (err) return console.error(err);
        console.log("Refreshed Creator Patreon Token");
      });
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      console.error(e.response.data);
    });
};

const checkCreatorToken = async () => {
  let isValid;
  await axios
    .get(`https://www.patreon.com/api/oauth2/v2/campaigns`, {
      headers: {
        Authorization: `Bearer ${patreon.CREATOR_ACCESS_TOKEN}`,
      },
    })
    .then((response) => {
      if (response.status < 400) {
        isValid = true;
      }
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      if (e.response.status === 401) {
        return console.error("Creator Patreon token has expired...");
      }
      console.error(e.response.data);
    });
  return isValid;
};

const getPatrons = async (skip) => {
  let data;
  await axios({
    url: `https://sso.angelthump.com/users?patreon.isPatron=true&$limit=10&$skip=${skip}`,
    method: "GET",
    headers: {
      "x-api-key": config.apiKey,
    },
  })
    .then((response) => {
      data = response.data;
    })
    .catch((e) => {
      console.error(e);
    });
  return data;
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

main();

setInterval(() => {
  main();
}, 1000 * 60 * 30);
