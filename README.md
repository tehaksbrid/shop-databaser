# Shop Databaser (SD)
This desktop application efficiently copies the <b>entirety</b> of any number of connected Shopify stores. The results are stored in a custom database in a highly compressed format. Data access is provided via queries, JSON exports, or direct terminal access.

Once synchronized to a store, this enables you to query approximately 1 million orders per minute.

<h2>Goals</h2>
<ol>
<li>Remake Shopify admin search with orders of magnitude more power, accuracy, and speed</li>
<li>Decouple the <b>analysis of Shopify data sets</b> from the <b>production of Shopify data sets</b></li>
</ol>

I have spent the last few years working with a number of very large Shopify stores. I would periodically get asked questions along the lines of:


<ul>
<li>What fulfillments contained item X today?</li>
<li>How has AOV changed over the history of the store?</li>
<li>What was AOV in orders placed after the customer used discount Y in a previous order?</li>
<li>How does actual delivery time for carrier/method A compared to carrier/method B?</li>
</ul>

The analysis involved in these queries is very simple, but just <b>collecting</b> the data accounted for 90% of the time cost. I would have to write some code to read the right data from Shopify, and usually end up throwing everything away when I was done.


I can't imagine I'm the only person frustrated by this, so I have written SD in an attempt to solve this problem as generally as possible.

<h2>Setup</h2>
<ol>
<li>Download and install <a href="//github.com/tehaksbrid/shop-databaser/release">the latest release of SD</a></li>
<li>Create a <b>private app token</b> (your-store.myshopify.com/admin/apps/private) with <b>read access</b> on the following permissions:
<ul>
<li>Customers, discounts, inventory, orders, price rules, and products</li>
</ul>
</li>
<li>From the <b>Stores</b> tab in SD, click <b>Add a store</b>. Enter a nickname + the myshopify URL/key/password.</li>
<li>Click "Connect". SD will validate the connection & permissions, then save the info. It will immediately begin copying all store data.</li>
</ol>


<h2>Guide to queries</h2>
This query language is inspired by xpath and has the following general structure

```
root_type [ field = value ] [ ... ] : subtype1 [ field = value ] [ ... ] : subtype2 ...
```

- `root_type` must always be one of `orders, fulfillments, customers, products, discounts, inventory`

<h4>Subtypes</h4>

- Subtypes have a number of access quantifiers
  - `:` Existential some<br/>`orders : line_items [ sku = ABC ]` &rarr; Orders where <b>some</b> line item has SKU ABC
  - `&` Existential every<br/>`orders & line_items [ sku = ABC ]` &rarr; Orders where <b>every</b> line item has SKU ABC
  - `*` None<br/>`orders * line_items [ sku = ABC ]` &rarr; Orders where <b>no</b> line item has SKU ABC
  
<h4>Fields and values</h4>

- Fields have a number of comparison functions
  - `=` Downcased string/number equality<br/> `customers [ first_name = zach ]` &rarr; Customers whose first name <b>equals</b> "zach" (or "Zach")
  - `~` Downcased string includes<br/> `customers [ first_name ~ zach ]` &rarr; Customers whose first name <b>includes</b> "zach" (also matches "Zachary")
  - `!` Downcased string not equals / integer not equals
  - `>`, `<`, `>=`, `<=` Number/date inequalities<br/> `customers [ orders_count > 1 ]` &rarr; Customers with more than 1 order<br/>`orders [ created_at > 1-1-20 ]` &rarr; Orders placed after January 1st 2020, based on your system time zone
- Field types and field values are automatically <b>coerced</b> to strings/integers/dates if and only if:
  - The field and the input both follow the same transformation (String &rarr; date, String &rarr; Integer)
  - The operator makes sense for the resulting type (eg `~` cannot act on integers or dates)
- You can execute serial field comparisons
  - `fulfillments : events [ status = delivered ] [ happenedAt > 1-1-20 ]` &rarr; Fulfillments that were marked as delivered after January 1st 2020

<h4>Misc</h4>

<ul>
<li>New lines are fed the results of the previous line
<ul><li>

```
orders : line_items : properties [ name = engraving ]
orders [ created_at > 1-1-20 ]
```
This filters for <b>orders</b> placed after January 1st 2020 with some line items that have some line item property named "engraving".<br/>
</li></ul>
</li>
</ul>

- SD will join different data sets if it can determine a relationship between them. In the current release, those are:
  - `orders: fulfillments`, `orders: customers`
  - `fulfillments: orders`
  - `line_items: products`
  - `customers : orders`
  - `variants: inventory`
  

<h2>Example queries</h2>

<h5>Customers that had an order delivered on or after January 1st 2020</h5>

```
customers : orders : fulfillments : events [ status = delivered ] [ happenedAt > 1-1-20 ]
```

<h5>Free orders</h5>

```
orders [ subtotal_price = 0 ]
```

<h5>Unpaid orders that have fulfillments</h5>

```
orders [ financial_status = pending ]
orders : fulfillments
```

<h5>Orders where a specific item was refunded</h5>

```
orders :  refunds : refund_line_items : line_item [ sku = ABC ]
```

<h5>Orders with refunds that were created on or after January 1st 2020</h5>

```
orders : refunds [ created_at > 1-1-20 ]
```

<h5>Products with an image exceeding 1MP</h5>

```
products : images [ height > 1000 ] [ width > 1000 ]
```

<h5>Products with no HTS code</h5>

```
products : variants : inventory [ harmonized_system_code = null ]
```

<h5>Customers who have used a specific discount code</h5>

```
customers : orders : discount_codes [ code = ABC ]
```

<h2>Data structure</h2>
The data generally follows <a href="https://shopify.dev/docs/admin-api/rest/reference">Shopify's definitions</a> for each root type (<code>orders, fulfillments, customers, products, discounts, inventory</code>), with a few notable exceptions:

- `order.fulfillments` is replaced with an array of fulfillment IDs, and those fulfillments are stored separately. This allows querying fulfillments without referencing the parent orders.
- `order.customer` is replaced with an array whose sole member is the customer ID. This is done to avoid storing redundant or conflicting copies of the data.
- `fulfillment.events` is added to eligible (`fulfillment.shipment_status` non-null) fulfillments. This is gathered from Shopify's GraphQL API and is an array of `{status, happenedAt}`.

The fastest way to explore each data structure is to simply query the type and send the results to a javascript console.

<h2>FAQs</h2>
<h5>Q. Is this an "open source" project?</h5>
<b>No.</b> The source code is <em>public</em>, as I would never ask store owners to put such powerful Shopify access tokens into an application whose security they could not personally validate. While I hope this project can help you enhance the profits of your store, I retain the rights to sell or monetize the code itself.

<h5>Q. Why does this use private tokens?</h5>
Private tokens give their bearer access to the entire history of your store. App tokens can only access the past 60 days worth of data. I chose private tokens to make SD more powerful.

<h5>Q. Does SD collect usage data?</h5>
At this time, <b>no</b>. I have interest in sampling specific datasets in the future to support some AI projects. If this happens, it will be an explicit opt-in.

<h5>Q. Can you add...</h5>
I will absolutely consider it and discuss the request. Please submit a feature request via the <a href="//github.com/tehaksbrid/shop-databaser/issues">Issues</a> tab.

<h5>Q. Is SD self-updating?</h5>
At present, no. Beta version 1 does not check for updates.

<h5>Q. This query language is dumb</h5>
Yup sure is, that's why I added the "Send to console" / "Send to file" buttons.

<h5>Q. How much storage space will this consume?</h5>
My test stores (around 250k orders per store) were each around 200 MB on disk. Your stats may vary. Under the hood, we collect orders/products/whatever into chunks and gzip the binary objects, then store that. This method gets us >90% compression.

<h5>Q. How long does it take to download everything?</h5>
Stores with 250k orders currently finish in about 4 hours. Your stats may vary. After this, SD will periodically check in with the store to get recent changes.

<h5>Q. My order/product/whatever is missing!</h5>
I expect SD to be slightly out of date (~10 minutes) at any time. Some types of events/changes are difficult to track in real-time. Fulfillments, for example, can be created on very old orders and Shopify sometimes will not emit events for this. If your data has not appeared after waiting an hour or so, I recommend forcing a re-sync.<br/>


Shopify is not able to reliably gather or parse tracking events from all carriers. Shippo USPS is notable here for <b>never</b> having <code>events</code> data.

<h5>Q. What kind of system resource usage should I expect?</h5>
When all historical data has finished downloading, <1% CPU and <200MB of RAM.<br/>
When downloading historical data, my Ryzen 3700x would occasionally spike up to ~10% due to large data compression tasks.<br/>
During very complex queries (nested queries with millions of date comparisons), I typically see 30% CPU.

<h5>Q. Can I export my data?</h5>
Yes. Query the type your want to export (eg "orders"), then click the "Send results to file" button. Just be aware that the JSON string will be >10X larger than the compressed data. Orders will export to ~1GB / 100k orders.

<h5>Q. Can I query inventory levels with this?</h5>
Presently, no. If you would like a more detailed way to analyze inventory data, I suggest looking at your WMS API.

<h2>Future work</h2>
Demand pending, I am considering the following feature additions:

 - Finer store permissions. For example, excluding the `customers` permission would cause SD to not attempt downloading that data.
 - A server-friendly version
 - More robust parent/child relationships. Would be nice to be able to link children to grandparents (eg line_item &rarr; variant
 

<h2>Disclaimer</h2>
This is application is a novelty not intended to support production software workloads and is not guaranteed to be reliable or accurate. See licensing.

