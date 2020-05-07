const axios = require('axios');
const config = require('./config.json');

const main = async() => {
    const totalPatrons = await getTotalPatrons();
    let skip = 0;
    let currentPatrons = [];
    do {
        currentPatrons = currentPatrons.concat(await getCurrentPatrons(skip));
        skip+=10;
    } while(totalPatrons != currentPatrons.length);
    
    for(let patron of currentPatrons) {
        verifyPatreon(patron);
        await sleep(300);
    }
}

const formUrlEncoded = x =>
   Object.keys(x).reduce((p, c) => p + `&${c}=${encodeURIComponent(x[c])}`, '');

const refresh = (user) => {
    const CLIENT_ID = config.patreon.CLIENT_ID;
    const CLIENT_SECRET = config.patreon.CLIENT_SECRET;

    axios({
        method: 'POST',
        url: "https://www.patreon.com/api/oauth2/token",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: formUrlEncoded({
            grant_type: 'refresh_token',
            refresh_token: user.patreon.refresh_token,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        })
    }).then(response => {
        let patreonObject = user.patreon;
        patreonObject.access_token = response.data.access_token;
        patreonObject.refresh_token = response.data.refresh_token;

        axios({
            method: 'PATCH',
            url: `https://sso.angelthump.com/users/${user.id}`,
            headers: {
                "x-api-key": config.apiKey
            },
            data: {
                patreon: patreonObject
            }
        }).then(() => {
            verifyPatreon(user);
        }).catch(e => {
            return console.error(e.message);
        });

    }).catch(e => {
        console.error(e.response.data);
    })
};

const verifyPatreon = async (user) => {
    const campaignID = config.campaignID;
    const userPatreonObject = user.patreon;

    const patronData =
    await axios('https://www.patreon.com/api/oauth2/v2/identity?include=memberships.campaign&fields%5Bmember%5D=full_name,is_follower,email,last_charge_date,last_charge_status,lifetime_support_cents,patron_status,currently_entitled_amount_cents,pledge_relationship_start,will_pay_amount_cents&fields%5Btier%5D=title&fields%5Buser%5D=full_name,hide_pledges', {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userPatreonObject.access_token}`,
        }
    }).then(response => {
        if(response.data.included && typeof response.data.included[Symbol.iterator] === 'function') {
            for(const included of response.data.included) {
                if(included.relationships) {
                    if(campaignID == included.relationships.campaign.data.id) {
                        return included;
                    }
                }
            }
        }
    }).catch(e => {
        if(e.response.status === 401) {
            return refresh(user);
        }
        console.error(e.response.data);
    });

    if(!patronData) {
        //no data, could be self edited database user. don't do anything?
        return;
    }

    const {currently_entitled_amount_cents, patron_status, last_charge_status} = patronData.attributes;

    if (currently_entitled_amount_cents >= 500 && patron_status === 'active_patron' && last_charge_status === 'Paid') {
        return;
    }

    //console.log(patronData.attributes);

    let patreonObject = userPatreonObject;
    patreonObject.isPatron = false;
    patreonObject.tier = 0;

    console.log(`${user.username} is no longer a patron. currently_entitled_amount_cents: ${currently_entitled_amount_cents} || patron_status: ${patron_status} || last_charge_status: ${last_charge_status}`);

    axios({
        method: 'PATCH',
        url: `https://sso.angelthump.com/users/${user.id}`,
        headers: {
            "x-api-key": config.apiKey
        },
        data: {
            patreon: patreonObject,
            password_protect: false,
            unlist: false
        }
    }).catch(e => {
        return console.error(e.message);
    });
}

const getCurrentPatrons = async(skip) => {
    let currentPatrons = [];
    await axios({
        url: `https://sso.angelthump.com/users?patreon.isPatron=true&$limit=10&$skip=${skip}`,
        method: "GET",
        headers: {
            "x-api-key": config.apiKey
        }
    })
    .then(response => {
        currentPatrons = response.data.data;
    }).catch(e => {
        console.error(e);
    })
    return currentPatrons;
}

const getTotalPatrons = async() => {
    let total;
    await axios({
        url: `https://sso.angelthump.com/users?patreon.isPatron=true&$limit=0`,
        method: "GET",
        headers: {
            "x-api-key": config.apiKey
        }
    })
    .then(response => {
        total = response.data.total;
    }).catch(e => {
        console.error(e);
    })
    return total;
}

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('verifying patrons');

main();

setInterval(() => {
    main();
}, 1000 * 60 * 30)